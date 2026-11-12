// wasdengine-game-layer: Node-API module of the WASD Engine Desktop main process on macOS.
//
// A windowless Godot game draws into a Core Animation layer that LibGodot's embedded display server shares through a
// CAContext. This module shows that layer in an Electron window: a CALayerHost in a view that sits above the window's
// vibrancy view and below Chromium's views, so the game shows where the page leaves its rectangle transparent, and
// the page's overlays and every web contents view added later, such as an account page, draw over it. The view takes
// no mouse events; the page receives them.
//
// Chromium sorts the content view's subviews whenever its views change, for example when Electron adds or removes a
// WebContentsView: background effect views first, then its compositor's view and the web contents views, then every
// other view, which would lift the game's view above the page. So attach gives the class of the window's content view,
// once per class, a sortSubviewsUsingFunction:context: that keeps the game's views right above the background effect
// views and leaves the order of every other view to Chromium.
//
//   attach(windowHandle: Buffer) -> handle
//       windowHandle: BrowserWindow.getNativeWindowHandle(), an NSView of the window. The view starts hidden.
//   place(handle, context, x, y, width, height, layerWidth, layerHeight)
//       Shows the layer of CAContext `context` in the rectangle x, y, width, height, in points from the top-left
//       corner of the window's content view, scaled to fit the layer's size in points.
//   detach(handle)
//       Removes the view. A handle that JavaScript drops without detaching removes its view when collected.
//
// Every function runs on the main thread, which in Electron's main process is the AppKit main thread.
// CAContext and CALayerHost are QuartzCore SPI, which Chromium and the Godot editor use the same way.

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <utility>
#include <vector>

typedef uint32_t CAContextID;

@interface CALayerHost : CALayer
@property CAContextID contextId;
@end

@interface WasdGameLayerView : NSView
@property(nonatomic, strong) CALayerHost *host;
@end

@implementation WasdGameLayerView
- (NSView *)hitTest:(NSPoint)point {
	return nil;
}
@end

namespace {

struct Handle {
	WasdGameLayerView *view;
};

// A view that Chromium sorts below its compositor and web contents views, as remote_cocoa's IsBackgroundEffectView
// decides: the window's vibrancy view, and on macOS 26 and later a glass effect view.
bool IsBackgroundView(NSView *view) {
	static Class glass = NSClassFromString(@"NSGlassEffectView");
	return [view isKindOfClass:[NSVisualEffectView class]] || (glass != nil && [view isKindOfClass:glass]);
}

using SubviewComparator = NSComparisonResult (*)(__kindof NSView *, __kindof NSView *, void *);
using SortSubviews = void (*)(id, SEL, SubviewComparator, void *);

// The comparator and context of one sortSubviewsUsingFunction:context: call.
struct SortRequest {
	SubviewComparator compare;
	void *context;
};

// The requested order, except that a game's view goes right above the background views and below every other view.
NSComparisonResult CompareKeepingGameBelowPage(__kindof NSView *lhs, __kindof NSView *rhs, void *request) {
	const bool leftGame = [lhs isKindOfClass:[WasdGameLayerView class]];
	const bool rightGame = [rhs isKindOfClass:[WasdGameLayerView class]];
	if (leftGame && !rightGame) {
		return IsBackgroundView(rhs) ? NSOrderedDescending : NSOrderedAscending;
	}
	if (rightGame && !leftGame) {
		return IsBackgroundView(lhs) ? NSOrderedAscending : NSOrderedDescending;
	}
	const SortRequest *sort = static_cast<const SortRequest *>(request);
	return sort->compare(lhs, rhs, sort->context);
}

// The sortSubviewsUsingFunction:context: implementations that the override replaced, by class.
std::vector<std::pair<const void *, SortSubviews>> &ReplacedSorts() {
	static std::vector<std::pair<const void *, SortSubviews>> replaced;
	return replaced;
}

// The implementation that the nearest overridden class of `cls` had before the override, or nullptr.
SortSubviews ReplacedSortOf(Class cls) {
	for (Class current = cls; current != nil; current = class_getSuperclass(current)) {
		for (const auto &entry : ReplacedSorts()) {
			if (entry.first == (__bridge const void *)current) {
				return entry.second;
			}
		}
	}
	return nullptr;
}

void SortSubviewsKeepingGameBelowPage(NSView *self, SEL selector, SubviewComparator compare, void *context) {
	const SortSubviews replaced = ReplacedSortOf(object_getClass(self));
	SortRequest request{ compare, context };
	replaced(self, selector, &CompareKeepingGameBelowPage, &request);
}

// Override sortSubviewsUsingFunction:context: in the class of a window's content view, once per class.
void KeepGameBelowPageWhenSorted(NSView *content) {
	Class cls = [content class];
	if (cls == [NSView class] || ReplacedSortOf(cls) != nullptr) {
		return;
	}
	const SEL selector = @selector(sortSubviewsUsingFunction:context:);
	Method method = class_getInstanceMethod(cls, selector);
	if (method == nullptr) {
		return;
	}
	ReplacedSorts().emplace_back((__bridge const void *)cls, reinterpret_cast<SortSubviews>(method_getImplementation(method)));
	const IMP override = reinterpret_cast<IMP>(&SortSubviewsKeepingGameBelowPage);
	if (!class_addMethod(cls, selector, override, method_getTypeEncoding(method))) {
		method_setImplementation(method, override);
	}
}

napi_value Fail(napi_env env, const char *message) {
	napi_throw_error(env, "WASD_GAME_LAYER", message);
	return nullptr;
}

void Remove(Handle *handle) {
	[handle->view removeFromSuperview];
	handle->view = nil;
}

void Finalize(napi_env env, void *data, void *hint) {
	Handle *handle = static_cast<Handle *>(data);
	Remove(handle);
	delete handle;
}

Handle *HandleOf(napi_env env, napi_value value) {
	void *data = nullptr;
	if (napi_get_value_external(env, value, &data) != napi_ok || data == nullptr) {
		return nullptr;
	}
	return static_cast<Handle *>(data);
}

napi_value Attach(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
		return Fail(env, "attach takes the window handle");
	}
	void *bytes = nullptr;
	size_t length = 0;
	if (napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok || length != sizeof(void *)) {
		return Fail(env, "the window handle is not a native view pointer");
	}
	NSView *windowView = (__bridge NSView *)(*static_cast<void **>(bytes));
	NSView *content = windowView.window.contentView;
	if (content == nil) {
		return Fail(env, "the window has no content view");
	}

	WasdGameLayerView *view = [[WasdGameLayerView alloc] initWithFrame:NSZeroRect];
	view.wantsLayer = YES;
	view.hidden = YES;
	// Keep the top-left corner in place while the window resizes; the page sends the next placement.
	view.autoresizingMask = NSViewMaxXMargin | NSViewMinYMargin;
	view.layer.masksToBounds = YES;
	// Black, as a game window starts, until the game's first frame and after its process ends.
	view.layer.backgroundColor = NSColor.blackColor.CGColor;
	CALayerHost *host = [CALayerHost new];
	host.anchorPoint = CGPointZero;
	view.host = host;
	[view.layer addSublayer:host];

	// Above the background views, such as the vibrancy view, which Electron and Chromium keep lowest, and below
	// Chromium's compositor and web contents views.
	NSView *background = nil;
	for (NSView *child in content.subviews) {
		if (IsBackgroundView(child)) {
			background = child;
		}
	}
	[content addSubview:view positioned:(background != nil ? NSWindowAbove : NSWindowBelow) relativeTo:background];
	KeepGameBelowPageWhenSorted(content);

	Handle *handle = new Handle{ view };
	napi_value external;
	if (napi_create_external(env, handle, Finalize, nullptr, &external) != napi_ok) {
		Remove(handle);
		delete handle;
		return Fail(env, "cannot create the layer handle");
	}
	return external;
}

napi_value Place(napi_env env, napi_callback_info info) {
	size_t argc = 8;
	napi_value argv[8];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 8) {
		return Fail(env, "place takes the handle, the context, the rectangle, and the layer size");
	}
	Handle *handle = HandleOf(env, argv[0]);
	if (handle == nullptr || handle->view == nil || handle->view.superview == nil) {
		return Fail(env, "the layer is detached");
	}
	uint32_t context = 0;
	double geometry[6];
	if (napi_get_value_uint32(env, argv[1], &context) != napi_ok) {
		return Fail(env, "the context is not a number");
	}
	for (int i = 0; i < 6; i++) {
		if (napi_get_value_double(env, argv[i + 2], &geometry[i]) != napi_ok) {
			return Fail(env, "the rectangle and the layer size are numbers");
		}
	}
	const double x = geometry[0], y = geometry[1], width = geometry[2], height = geometry[3];
	const double layerWidth = geometry[4], layerHeight = geometry[5];
	if (!(width > 0 && height > 0 && layerWidth > 0 && layerHeight > 0)) {
		return Fail(env, "the rectangle and the layer size must be positive");
	}

	WasdGameLayerView *view = handle->view;
	NSView *content = view.superview;
	[CATransaction begin];
	[CATransaction setDisableActions:YES];
	const CGFloat top = content.isFlipped ? y : content.bounds.size.height - y - height;
	view.frame = NSMakeRect(x, top, width, height);
	CALayerHost *host = view.host;
	if (host.contextId != context) {
		host.contextId = context;
	}
	host.contentsScale = view.window.backingScaleFactor;
	// The hosted layer hangs down from the host's origin, so the origin goes to the view's top-left corner.
	host.position = CGPointMake(0, height);
	const CGFloat scale = MIN(width / layerWidth, height / layerHeight);
	host.transform = CATransform3DMakeScale(scale, scale, 1);
	view.hidden = NO;
	[CATransaction commit];
	return nullptr;
}

napi_value Detach(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
		return Fail(env, "detach takes the handle");
	}
	Handle *handle = HandleOf(env, argv[0]);
	if (handle == nullptr) {
		return Fail(env, "the value is not a layer handle");
	}
	Remove(handle);
	return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
	napi_property_descriptor properties[] = {
		{ "attach", nullptr, Attach, nullptr, nullptr, nullptr, napi_enumerable, nullptr },
		{ "place", nullptr, Place, nullptr, nullptr, nullptr, napi_enumerable, nullptr },
		{ "detach", nullptr, Detach, nullptr, nullptr, nullptr, napi_enumerable, nullptr },
	};
	if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
		return nullptr;
	}
	return exports;
}

} // namespace

NAPI_MODULE_INIT() {
	return Init(env, exports);
}
