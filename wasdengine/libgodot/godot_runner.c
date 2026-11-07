/*
 * godot_runner: hosts LibGodot (Godot Engine built with library_type=shared_library).
 *
 * Usage: godot_runner --libgodot <path> [--parent-pid <pid>] -- <godot arguments...>
 *
 * Loads the library, creates the one Godot instance the process may hold from the
 * arguments after "--" (argv[0] of the instance is this executable), starts it, and
 * calls GodotInstance.iteration() until the game quits, the process receives
 * SIGINT or SIGTERM (a console control event on Windows), or the process that
 * --parent-pid names exits. Engine output goes to this process's stdout and stderr.
 * Godot decodes its arguments as UTF-8, so on Windows, where the C runtime passes
 * main() the ANSI code page, the runner converts its UTF-16 command line to UTF-8
 * and loads the library by its UTF-16 path.
 *
 * --parent-pid must name the runner's parent process on macOS and Linux, and may name
 * any process on Windows, where the Host's subprocess service can start the runner
 * through a helper process. A thread watches that process: when it exits, the thread
 * stops the game as SIGTERM does and, if the engine has not shut down 3 seconds
 * (PARENT_EXIT_GRACE_SECONDS) later, for example because a script never returns,
 * terminates the runner.
 *
 * Exit status: the engine's own exit code is not visible through LibGodot, so the
 * runner exits 0 after the game quits or a stop request ends it, 2 on a usage error
 * (including a --parent-pid that names a running process other than the parent on
 * macOS and Linux), 3 when the library cannot be loaded, 4 when the instance cannot
 * be created, 5 when it does not start, and 6 when the --parent-pid process is not
 * running or cannot be watched, or the engine does not shut down in time after it exits.
 *
 * The GDExtension declarations below are the subset of
 * core/extension/gdextension_interface.json (Godot 4.6+) that the runner calls.
 */

#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#else
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#endif

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <sys/event.h>
extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *pool);
#endif

#ifdef __linux__
#include <semaphore.h>
#include <sys/prctl.h>
#endif

typedef void *GDExtensionObjectPtr;
typedef void *GDExtensionClassLibraryPtr;
typedef void *GDExtensionVariantPtr;
typedef const void *GDExtensionConstVariantPtr;
typedef void *GDExtensionTypePtr;
typedef const void *GDExtensionConstStringNamePtr;
typedef uint8_t GDExtensionBool;
typedef int64_t GDExtensionInt;
typedef void (*GDExtensionInterfaceFunctionPtr)(void);
typedef GDExtensionInterfaceFunctionPtr (*GDExtensionInterfaceGetProcAddress)(const char *p_function_name);

typedef enum {
	GDEXTENSION_INITIALIZATION_CORE = 0,
	GDEXTENSION_INITIALIZATION_SERVERS = 1,
	GDEXTENSION_INITIALIZATION_SCENE = 2,
	GDEXTENSION_INITIALIZATION_EDITOR = 3,
	GDEXTENSION_MAX_INITIALIZATION_LEVEL = 4,
} GDExtensionInitializationLevel;

typedef struct {
	GDExtensionInitializationLevel minimum_initialization_level;
	void *userdata;
	void (*initialize)(void *userdata, GDExtensionInitializationLevel p_level);
	void (*deinitialize)(void *userdata, GDExtensionInitializationLevel p_level);
} GDExtensionInitialization;

typedef GDExtensionBool (*GDExtensionInitializationFunction)(GDExtensionInterfaceGetProcAddress p_get_proc_address, GDExtensionClassLibraryPtr p_library, GDExtensionInitialization *r_initialization);

typedef struct {
	int32_t error;
	int32_t argument;
	int32_t expected;
} GDExtensionCallError;

enum {
	GDEXTENSION_VARIANT_TYPE_STRING_NAME = 21,
	GDEXTENSION_VARIANT_TYPE_OBJECT = 24,
};

typedef GDExtensionObjectPtr (*CreateInstanceFn)(int p_argc, char *p_argv[], GDExtensionInitializationFunction p_init_func);
typedef void (*DestroyInstanceFn)(GDExtensionObjectPtr p_godot_instance);
typedef void (*VariantFromTypeFn)(GDExtensionVariantPtr r_dest, GDExtensionTypePtr p_from);
typedef VariantFromTypeFn (*GetVariantFromTypeConstructorFn)(int32_t p_type);
typedef void (*StringNameNewWithLatin1CharsFn)(void *r_dest, const char *p_contents, GDExtensionBool p_is_static);
typedef void (*VariantCallFn)(GDExtensionVariantPtr p_self, GDExtensionConstStringNamePtr p_method, const GDExtensionConstVariantPtr *p_args, GDExtensionInt p_argument_count, GDExtensionVariantPtr r_return, GDExtensionCallError *r_error);
typedef GDExtensionBool (*VariantBooleanizeFn)(GDExtensionConstVariantPtr p_self);
typedef void (*VariantDestroyFn)(GDExtensionVariantPtr p_self);
typedef void (*PtrDestructorFn)(GDExtensionTypePtr p_base);
typedef PtrDestructorFn (*VariantGetPtrDestructorFn)(int32_t p_type);

/* A Variant is 24 bytes (40 with precision=double); a StringName is one pointer. */
typedef struct {
	_Alignas(16) unsigned char bytes[64];
} VariantStorage;

typedef struct {
	_Alignas(16) unsigned char bytes[16];
} StringNameStorage;

/* Exit statuses; the header comment describes when each applies. */
enum {
	RUNNER_EXIT_USAGE = 2,
	RUNNER_EXIT_LIBRARY = 3,
	RUNNER_EXIT_INSTANCE = 4,
	RUNNER_EXIT_START = 5,
	RUNNER_EXIT_PARENT = 6,
};

/* How long the engine may take to shut down after the --parent-pid process exits. */
#define PARENT_EXIT_GRACE_SECONDS 3

static GDExtensionInterfaceGetProcAddress get_proc_address = NULL;
static long watched_parent_pid = 0;

#ifdef _WIN32
/* Console control handlers and the parent watch run on threads of their own. */
static volatile LONG stop_requested = 0;

static void request_stop(void) {
	InterlockedExchange(&stop_requested, 1);
}

static int stop_is_requested(void) {
	return InterlockedCompareExchange(&stop_requested, 0, 0) != 0;
}
#else
/* Signal handlers may store to a lock-free atomic object; the parent watch stores from its own thread. */
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "signal handlers need a lock-free atomic_int");
static atomic_int stop_requested;

static void request_stop(void) {
	atomic_store(&stop_requested, 1);
}

static int stop_is_requested(void) {
	return atomic_load(&stop_requested);
}
#endif

#ifdef __linux__
/* PR_SET_PDEATHSIG sends SIGTERM when the parent exits; on_signal posts this semaphore to wake the parent watch. */
static sem_t parent_watch_wakeup;
static volatile sig_atomic_t parent_watch_wakeup_ready = 0;
#endif

static void initialize_level(void *userdata, GDExtensionInitializationLevel level) {
	(void)userdata;
	(void)level;
}

static GDExtensionBool host_init(GDExtensionInterfaceGetProcAddress p_get_proc_address, GDExtensionClassLibraryPtr p_library, GDExtensionInitialization *r_initialization) {
	(void)p_library;
	get_proc_address = p_get_proc_address;
	r_initialization->minimum_initialization_level = GDEXTENSION_INITIALIZATION_CORE;
	r_initialization->userdata = NULL;
	r_initialization->initialize = initialize_level;
	r_initialization->deinitialize = initialize_level;
	return 1;
}

#ifdef _WIN32
static BOOL WINAPI on_console_event(DWORD event) {
	(void)event;
	request_stop();
	return TRUE;
}
#else
static void on_signal(int signal_number) {
	(void)signal_number;
	request_stop();
#ifdef __linux__
	if (parent_watch_wakeup_ready) {
		int saved_errno = errno;
		sem_post(&parent_watch_wakeup);
		errno = saved_errno;
	}
#endif
}

/* Godot's macOS windowed OS layer replaces the SIGINT handler while the instance is created, so main installs these twice. */
static void install_stop_handlers(void) {
	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
}
#endif

static void *load_symbol(void *library, const char *name) {
#ifdef _WIN32
	return (void *)GetProcAddress((HMODULE)library, name);
#else
	return dlsym(library, name);
#endif
}

static GDExtensionInterfaceFunctionPtr require_proc(const char *name) {
	GDExtensionInterfaceFunctionPtr function = get_proc_address(name);
	if (function == NULL) {
		fprintf(stderr, "godot_runner: LibGodot does not provide %s\n", name);
	}
	return function;
}

/*
 * Runs on the parent watch thread once the --parent-pid process has exited or the watch
 * failed: stops the game, and terminates the runner when the engine has not shut down
 * within the grace period.
 */
static void stop_after_parent_exit(int parent_exited, long error) {
	if (parent_exited) {
		fprintf(stderr, "godot_runner: process %ld exited; stopping the game\n", watched_parent_pid);
	} else {
		fprintf(stderr, "godot_runner: lost the watch on process %ld (error %ld); stopping the game\n", watched_parent_pid, error);
	}
	request_stop();
#ifdef _WIN32
	Sleep(PARENT_EXIT_GRACE_SECONDS * 1000);
#else
	struct timespec remaining = { PARENT_EXIT_GRACE_SECONDS, 0 };
	while (nanosleep(&remaining, &remaining) != 0 && errno == EINTR) {
	}
#endif
	fprintf(stderr, "godot_runner: the engine did not shut down within %d seconds; terminating the runner\n", PARENT_EXIT_GRACE_SECONDS);
#ifdef _WIN32
	TerminateProcess(GetCurrentProcess(), RUNNER_EXIT_PARENT);
#else
	_exit(RUNNER_EXIT_PARENT);
#endif
}

#ifdef _WIN32
static DWORD WINAPI watch_parent(LPVOID parent) {
	int exited = WaitForSingleObject((HANDLE)parent, INFINITE) == WAIT_OBJECT_0;
	stop_after_parent_exit(exited, exited ? 0 : (long)GetLastError());
	return 0;
}
#else
#ifdef __APPLE__
static int parent_watch_queue = -1;
#endif

static void *watch_parent(void *unused) {
	(void)unused;
#ifdef __APPLE__
	struct kevent event;
	int events;
	do {
		events = kevent(parent_watch_queue, NULL, 0, &event, 1, NULL);
	} while (events < 0 && errno == EINTR);
	stop_after_parent_exit(events >= 0, events >= 0 ? 0 : errno);
#else
	int error = 0;
	while (error == 0 && (long)getppid() == watched_parent_pid) {
		if (sem_wait(&parent_watch_wakeup) != 0 && errno != EINTR) {
			error = errno;
		}
	}
	stop_after_parent_exit(error == 0, error);
#endif
	return NULL;
}
#endif

/* Starts the parent watch thread; returns 0, or the exit status after reporting why the process cannot be watched. */
static int start_parent_watch(long parent_pid) {
	watched_parent_pid = parent_pid;
#ifdef _WIN32
	HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)parent_pid);
	if (parent == NULL) {
		fprintf(stderr, "godot_runner: cannot watch process %ld (error %lu)\n", parent_pid, (unsigned long)GetLastError());
		return RUNNER_EXIT_PARENT;
	}
	HANDLE thread = CreateThread(NULL, 0, watch_parent, parent, 0, NULL);
	if (thread == NULL) {
		fprintf(stderr, "godot_runner: cannot start the watch on process %ld (error %lu)\n", parent_pid, (unsigned long)GetLastError());
		return RUNNER_EXIT_PARENT;
	}
	CloseHandle(thread);
	return 0;
#else
#ifdef __APPLE__
	struct kevent change;
	EV_SET(&change, (uintptr_t)parent_pid, EVFILT_PROC, EV_ADD, NOTE_EXIT, 0, NULL);
	parent_watch_queue = kqueue();
	if (parent_watch_queue < 0 || kevent(parent_watch_queue, &change, 1, NULL, 0, NULL) != 0) {
		fprintf(stderr, "godot_runner: cannot watch process %ld: %s\n", parent_pid, strerror(errno));
		return RUNNER_EXIT_PARENT;
	}
#else
	if (sem_init(&parent_watch_wakeup, 0, 0) != 0) {
		fprintf(stderr, "godot_runner: cannot watch process %ld: %s\n", parent_pid, strerror(errno));
		return RUNNER_EXIT_PARENT;
	}
	parent_watch_wakeup_ready = 1;
	prctl(PR_SET_PDEATHSIG, SIGTERM);
#endif
	/* Checked once the watch is in place, so a parent that exits before it is not missed. */
	if ((long)getppid() != parent_pid) {
		if (kill((pid_t)parent_pid, 0) == 0 || errno == EPERM) {
			fprintf(stderr, "godot_runner: --parent-pid %ld is not the parent of this process\n", parent_pid);
			return RUNNER_EXIT_USAGE;
		}
		fprintf(stderr, "godot_runner: process %ld is not running\n", parent_pid);
		return RUNNER_EXIT_PARENT;
	}
	pthread_t thread;
	int error = pthread_create(&thread, NULL, watch_parent, NULL);
	if (error != 0) {
		fprintf(stderr, "godot_runner: cannot start the watch on process %ld: %s\n", parent_pid, strerror(error));
		return RUNNER_EXIT_PARENT;
	}
	pthread_detach(thread);
	return 0;
#endif
}

/* Parses a positive decimal process id. */
static int parse_pid(const char *text, long *pid) {
	char *end = NULL;
	errno = 0;
	long value = strtol(text, &end, 10);
	if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > INT32_MAX) {
		return 0;
	}
	*pid = value;
	return 1;
}

#ifdef _WIN32
/* Converts the arguments to UTF-8 strings that live until the process exits; returns NULL when memory runs out. */
static char **utf8_arguments(LPWSTR *arguments, int count) {
	char **converted = (char **)calloc((size_t)count + 1, sizeof(char *));
	for (int i = 0; converted != NULL && i < count; i++) {
		int size = WideCharToMultiByte(CP_UTF8, 0, arguments[i], -1, NULL, 0, NULL, NULL);
		converted[i] = size > 0 ? (char *)malloc((size_t)size) : NULL;
		if (converted[i] == NULL || WideCharToMultiByte(CP_UTF8, 0, arguments[i], -1, converted[i], size, NULL, NULL) != size) {
			return NULL;
		}
	}
	return converted;
}
#endif

static void usage(void) {
	fprintf(stderr, "usage: godot_runner --libgodot <path> [--parent-pid <pid>] -- <godot arguments...>\n");
}

int main(int argc, char *argv[]) {
#ifdef _WIN32
	LPWSTR *wide_argv = CommandLineToArgvW(GetCommandLineW(), &argc);
	argv = wide_argv == NULL ? NULL : utf8_arguments(wide_argv, argc);
	if (argv == NULL) {
		fprintf(stderr, "godot_runner: cannot convert the command line to UTF-8\n");
		return RUNNER_EXIT_USAGE;
	}
#endif
	int library_index = -1;
	long parent_pid = 0;
	int separator = -1;
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--") == 0) {
			separator = i;
			break;
		}
		if (strcmp(argv[i], "--libgodot") == 0 && i + 1 < argc) {
			library_index = ++i;
		} else if (strcmp(argv[i], "--parent-pid") == 0 && i + 1 < argc && parse_pid(argv[i + 1], &parent_pid)) {
			i++;
		} else {
			usage();
			return RUNNER_EXIT_USAGE;
		}
	}
	if (library_index < 0 || separator < 0) {
		usage();
		return RUNNER_EXIT_USAGE;
	}
	const char *library_path = argv[library_index];

#ifdef _WIN32
	SetConsoleCtrlHandler(on_console_event, TRUE);
#else
	install_stop_handlers();
	signal(SIGPIPE, SIG_IGN);
#endif
	if (parent_pid > 0) {
		int watch_status = start_parent_watch(parent_pid);
		if (watch_status != 0) {
			return watch_status;
		}
	}

#ifdef _WIN32
	void *library = (void *)LoadLibraryW(wide_argv[library_index]);
#else
	void *library = dlopen(library_path, RTLD_NOW | RTLD_LOCAL);
#endif
	if (library == NULL) {
#ifdef _WIN32
		fprintf(stderr, "godot_runner: cannot load %s (error %lu)\n", library_path, (unsigned long)GetLastError());
#else
		fprintf(stderr, "godot_runner: cannot load %s: %s\n", library_path, dlerror());
#endif
		return RUNNER_EXIT_LIBRARY;
	}

	CreateInstanceFn create_instance = (CreateInstanceFn)load_symbol(library, "libgodot_create_godot_instance");
	DestroyInstanceFn destroy_instance = (DestroyInstanceFn)load_symbol(library, "libgodot_destroy_godot_instance");
	if (create_instance == NULL || destroy_instance == NULL) {
		fprintf(stderr, "godot_runner: %s is not a LibGodot build (library_type=shared_library)\n", library_path);
		return RUNNER_EXIT_LIBRARY;
	}

	/* The instance sees argv[0] (this executable) followed by the arguments after "--". */
	int godot_argc = argc - separator;
	char **godot_argv = (char **)calloc((size_t)godot_argc + 1, sizeof(char *));
	if (godot_argv == NULL) {
		return RUNNER_EXIT_INSTANCE;
	}
	godot_argv[0] = argv[0];
	for (int i = separator + 1; i < argc; i++) {
		godot_argv[i - separator] = argv[i];
	}

	GDExtensionObjectPtr instance = create_instance(godot_argc, godot_argv, host_init);
	if (instance == NULL || get_proc_address == NULL) {
		fprintf(stderr, "godot_runner: LibGodot could not create an instance from the given arguments\n");
		return RUNNER_EXIT_INSTANCE;
	}
#ifndef _WIN32
	install_stop_handlers();
#endif

	GetVariantFromTypeConstructorFn get_variant_from_type = (GetVariantFromTypeConstructorFn)require_proc("get_variant_from_type_constructor");
	StringNameNewWithLatin1CharsFn string_name_new = (StringNameNewWithLatin1CharsFn)require_proc("string_name_new_with_latin1_chars");
	VariantCallFn variant_call = (VariantCallFn)require_proc("variant_call");
	VariantBooleanizeFn variant_booleanize = (VariantBooleanizeFn)require_proc("variant_booleanize");
	VariantDestroyFn variant_destroy = (VariantDestroyFn)require_proc("variant_destroy");
	VariantGetPtrDestructorFn get_ptr_destructor = (VariantGetPtrDestructorFn)require_proc("variant_get_ptr_destructor");
	if (get_variant_from_type == NULL || string_name_new == NULL || variant_call == NULL || variant_booleanize == NULL || variant_destroy == NULL || get_ptr_destructor == NULL) {
		destroy_instance(instance);
		return RUNNER_EXIT_INSTANCE;
	}

	VariantStorage instance_variant;
	memset(&instance_variant, 0, sizeof(instance_variant));
	get_variant_from_type(GDEXTENSION_VARIANT_TYPE_OBJECT)(&instance_variant, &instance);

	StringNameStorage start_name, iteration_name, focus_in_name;
	memset(&start_name, 0, sizeof(start_name));
	memset(&iteration_name, 0, sizeof(iteration_name));
	memset(&focus_in_name, 0, sizeof(focus_in_name));
	string_name_new(&start_name, "start", 0);
	string_name_new(&iteration_name, "iteration", 0);
	string_name_new(&focus_in_name, "focus_in", 0);

	int status = 0;
	VariantStorage result;
	GDExtensionCallError call_error;

	memset(&result, 0, sizeof(result));
	variant_call(&instance_variant, &start_name, NULL, 0, &result, &call_error);
	int started = call_error.error == 0 && variant_booleanize(&result);
	variant_destroy(&result);
	if (!started) {
		fprintf(stderr, "godot_runner: GodotInstance.start() failed\n");
		status = RUNNER_EXIT_START;
	} else {
		/* An embedded instance has no window to gain focus; report focus so games that pause without it keep running. */
		memset(&result, 0, sizeof(result));
		variant_call(&instance_variant, &focus_in_name, NULL, 0, &result, &call_error);
		variant_destroy(&result);

		while (!stop_is_requested()) {
#ifdef __APPLE__
			void *pool = objc_autoreleasePoolPush();
#endif
			memset(&result, 0, sizeof(result));
			variant_call(&instance_variant, &iteration_name, NULL, 0, &result, &call_error);
			int quit = call_error.error != 0 || variant_booleanize(&result);
			variant_destroy(&result);
#ifdef __APPLE__
			CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, 0);
			objc_autoreleasePoolPop(pool);
#endif
			if (quit) {
				break;
			}
		}
	}

	PtrDestructorFn destroy_string_name = get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME);
	if (destroy_string_name != NULL) {
		destroy_string_name(&start_name);
		destroy_string_name(&iteration_name);
		destroy_string_name(&focus_in_name);
	}
	variant_destroy(&instance_variant);
	destroy_instance(instance);
	free(godot_argv);
	return status;
}
