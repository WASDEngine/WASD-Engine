// wasdengine-game-layer: Node-API module of the WASD Engine Desktop main process on macOS.
//
// A windowless Godot game draws into a Core Animation layer that LibGodot's embedded display server shares through a
// CAContext. This module shows that layer in an Electron window: a CALayerHost in a view that sits above the window's
// vibrancy view and below Chromium's views, so the game shows where the page leaves its rectangle transparent, and
// the page's overlays draw over it. The view takes no mouse events; the page receives them.
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
#include <node_api.h>

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

	// Above the vibrancy view, which Electron keeps lowest, and below Chromium's compositor and web contents views.
	NSView *vibrancy = nil;
	for (NSView *child in content.subviews) {
		if ([child isKindOfClass:[NSVisualEffectView class]]) {
			vibrancy = child;
			break;
		}
	}
	[content addSubview:view positioned:(vibrancy != nil ? NSWindowAbove : NSWindowBelow) relativeTo:vibrancy];

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
