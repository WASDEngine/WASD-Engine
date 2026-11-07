/*
 * stub_libgodot: a stand-in for LibGodot that test_runner.py loads into godot_runner on macOS and Linux.
 *
 * It exports libgodot_create_godot_instance and libgodot_destroy_godot_instance, and
 * gives the runner the GDExtension interface functions that godot_runner.c calls.
 * GodotInstance.start(), iteration(), and focus_in() behave as the environment variable
 * STUB_LIBGODOT_MODE asks:
 *
 *   quit          iteration() asks the runner to quit on its third call (the default)
 *   run           iteration() keeps the game running, one call every 10 ms
 *   hang          iteration() never returns, like a script that never returns
 *   hang-start    start() never returns
 *   fail-create   instance creation fails
 *   fail-start    start() reports failure
 *
 * With STUB_LIBGODOT_TAKE_SIGINT=1, instance creation replaces the SIGINT handler with
 * one that does nothing, as Godot's macOS windowed OS layer does. The stub appends one
 * line per event to the file that STUB_LIBGODOT_LOG names: "create", then "arg <argument>"
 * for every argument it receives, "start", "focus_in", "iteration" on the first call,
 * "hang", and "destroy".
 */

#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef void (*InterfaceFunction)(void);
typedef InterfaceFunction (*GetProcAddress)(const char *name);

typedef struct {
	int minimum_initialization_level;
	void *userdata;
	void (*initialize)(void *userdata, int level);
	void (*deinitialize)(void *userdata, int level);
} Initialization;

typedef uint8_t (*InitializationFunction)(GetProcAddress get_proc_address, void *library, Initialization *initialization);

typedef struct {
	int32_t error;
	int32_t argument;
	int32_t expected;
} CallError;

static int instance_token;
static long iterations;

static const char *mode(void) {
	const char *value = getenv("STUB_LIBGODOT_MODE");
	return value == NULL ? "quit" : value;
}

static int mode_is(const char *name) {
	return strcmp(mode(), name) == 0;
}

static void log_event(const char *event, const char *detail) {
	const char *path = getenv("STUB_LIBGODOT_LOG");
	if (path == NULL) {
		return;
	}
	FILE *log = fopen(path, "a");
	if (log == NULL) {
		return;
	}
	if (detail == NULL) {
		fprintf(log, "%s\n", event);
	} else {
		fprintf(log, "%s %s\n", event, detail);
	}
	fclose(log);
}

static void hang(void) {
	log_event("hang", NULL);
	for (;;) {
		pause();
	}
}

static void ignore_signal(int signal_number) {
	(void)signal_number;
}

static void variant_from_object(void *destination, void *object) {
	memcpy(destination, object, sizeof(void *));
}

static InterfaceFunction get_variant_from_type_constructor(int32_t type) {
	(void)type;
	return (InterfaceFunction)variant_from_object;
}

static void string_name_new_with_latin1_chars(void *destination, const char *contents, uint8_t is_static) {
	(void)is_static;
	memcpy(destination, &contents, sizeof(contents));
}

static void variant_call(void *self, const void *method, const void *const *arguments, int64_t argument_count, void *result, CallError *error) {
	(void)self;
	(void)arguments;
	(void)argument_count;
	const char *name;
	memcpy(&name, method, sizeof(name));
	error->error = 0;
	uint8_t value = 0;
	if (strcmp(name, "start") == 0) {
		log_event("start", NULL);
		if (mode_is("hang-start")) {
			hang();
		}
		value = !mode_is("fail-start");
	} else if (strcmp(name, "focus_in") == 0) {
		log_event("focus_in", NULL);
	} else if (strcmp(name, "iteration") == 0) {
		if (++iterations == 1) {
			log_event("iteration", NULL);
		}
		if (mode_is("hang")) {
			hang();
		}
		if (mode_is("run")) {
			struct timespec delay = { 0, 10 * 1000 * 1000 };
			nanosleep(&delay, NULL);
		}
		value = mode_is("quit") && iterations >= 3;
	}
	memcpy(result, &value, sizeof(value));
}

static uint8_t variant_booleanize(const void *variant) {
	uint8_t value;
	memcpy(&value, variant, sizeof(value));
	return value;
}

static void variant_destroy(void *variant) {
	(void)variant;
}

static void destroy_pointer(void *pointer) {
	(void)pointer;
}

static InterfaceFunction variant_get_ptr_destructor(int32_t type) {
	(void)type;
	return (InterfaceFunction)destroy_pointer;
}

static InterfaceFunction get_proc_address(const char *name) {
	static const struct {
		const char *name;
		InterfaceFunction function;
	} functions[] = {
		{ "get_variant_from_type_constructor", (InterfaceFunction)get_variant_from_type_constructor },
		{ "string_name_new_with_latin1_chars", (InterfaceFunction)string_name_new_with_latin1_chars },
		{ "variant_call", (InterfaceFunction)variant_call },
		{ "variant_booleanize", (InterfaceFunction)variant_booleanize },
		{ "variant_destroy", (InterfaceFunction)variant_destroy },
		{ "variant_get_ptr_destructor", (InterfaceFunction)variant_get_ptr_destructor },
	};
	for (size_t i = 0; i < sizeof(functions) / sizeof(functions[0]); i++) {
		if (strcmp(functions[i].name, name) == 0) {
			return functions[i].function;
		}
	}
	return NULL;
}

void *libgodot_create_godot_instance(int argc, char *argv[], InitializationFunction initialize) {
	log_event("create", NULL);
	for (int i = 0; i < argc; i++) {
		log_event("arg", argv[i]);
	}
	if (mode_is("fail-create")) {
		return NULL;
	}
	const char *take_sigint = getenv("STUB_LIBGODOT_TAKE_SIGINT");
	if (take_sigint != NULL && strcmp(take_sigint, "1") == 0) {
		signal(SIGINT, ignore_signal);
	}
	Initialization initialization;
	memset(&initialization, 0, sizeof(initialization));
	initialize(get_proc_address, NULL, &initialization);
	return &instance_token;
}

void libgodot_destroy_godot_instance(void *instance) {
	(void)instance;
	log_event("destroy", NULL);
}
