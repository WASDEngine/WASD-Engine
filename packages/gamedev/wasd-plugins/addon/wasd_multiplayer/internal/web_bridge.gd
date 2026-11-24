# SPDX-License-Identifier: CC0-1.0
# The page side of WASD sign-in in a Web build: listens for "wasd:play:*" messages from the page that frames the game
# (a WASD game page) or from the sign-in window this game opened, says which page frames the game, posts requests to
# that page, and opens that window. Outside Web builds `available` is false and every method does nothing.
extends RefCounted

## Emitted for each "wasd:play:*" message. [param from] is "parent" or "popup"; [param origin] is the sender's origin.
signal message(from: String, origin: String, data: Dictionary)

const Tokens := preload("tokens.gd")

## The message listener installed once per page. It forwards only messages whose type starts with "wasd:play:" and
## that come from the framing page or from the window opened by open_popup(), as JSON text.
const _SHIM := """
(function () {
	if (window.__wasdPlay) { return; }
	var state = { popup: null, notify: null };
	state.setNotify = function (callback) { state.notify = callback; };
	window.__wasdPlay = state;
	window.addEventListener('message', function (event) {
		var data = event.data;
		if (!data || typeof data !== 'object' || typeof data.type !== 'string') { return; }
		if (data.type.indexOf('wasd:play:') !== 0) { return; }
		var from = '';
		if (window.parent !== window && event.source === window.parent) { from = 'parent'; }
		else if (state.popup && event.source === state.popup) { from = 'popup'; }
		else { return; }
		if (!state.notify) { return; }
		try { state.notify(JSON.stringify({ from: from, origin: String(event.origin), data: data })); }
		catch (error) { console.warn('WASD Multiplayer: a sign-in message could not be read.', error); }
	});
})();
"""

## The framing page's origin as the browser reports it: location.ancestorOrigins in Chromium and Safari, else the
## origin of document.referrer, the page that loaded the frame, which Firefox reports.
const _PARENT_ORIGIN := """
(function () {
	var origin = '';
	try {
		var ancestors = window.location.ancestorOrigins;
		if (ancestors && ancestors.length > 0) { origin = String(ancestors[0]); }
		else if (document.referrer) { origin = new URL(document.referrer).origin; }
	} catch (error) { origin = ''; }
	return origin === 'null' ? '' : origin;
})()
"""

## True in a Web build, where the page can be reached.
var available := false

var _callback: JavaScriptObject


func _init() -> void:
	available = OS.has_feature("web") and Engine.has_singleton("JavaScriptBridge")
	if not available:
		return
	JavaScriptBridge.eval(_SHIM, true)
	_callback = JavaScriptBridge.create_callback(_on_message)
	var state: JavaScriptObject = JavaScriptBridge.get_interface("__wasdPlay")
	if state == null:
		available = false
		push_warning("WASD Multiplayer: the page did not accept the sign-in listener, so online play is unavailable.")
		return
	state.setNotify(_callback)


## True when another page frames the game.
func is_framed() -> bool:
	return available and bool(JavaScriptBridge.eval("window.parent !== window", true))


## The origin of the page that frames the game, as the browser reports it, or "" when the game is not framed or the
## browser does not say. It tells where to address messages; who sent a message comes with the message.
func parent_origin() -> String:
	if not is_framed():
		return ""
	var origin: Variant = JavaScriptBridge.eval(_PARENT_ORIGIN, true)
	return origin if origin is String else ""


## Posts a message to the framing page when its origin is [param target_origin], one of the WASD website's: the browser
## drops it for a page of any other origin.
func post_parent(data: Dictionary, target_origin: String) -> void:
	if not is_framed():
		return
	var script := "try { window.parent.postMessage(%s, %s); } catch (error) {" \
			+ " console.warn('WASD Multiplayer: the message to the game page could not be sent.', error); }"
	JavaScriptBridge.eval(script % [JSON.stringify(data), JSON.stringify(target_origin)], true)


## Opens [param url] in the sign-in window. Browsers allow it only right after a click or key press.
func open_popup(url: String) -> bool:
	if not available:
		return false
	var script := "(function () { var w = window.open(%s, 'wasd-play-connect', 'popup,width=480,height=640');" \
			+ " window.__wasdPlay.popup = w; return !!w; })()"
	return bool(JavaScriptBridge.eval(script % JSON.stringify(url), true))


## True when the sign-in window is closed or was never opened.
func popup_closed() -> bool:
	if not available:
		return true
	return bool(JavaScriptBridge.eval("!window.__wasdPlay.popup || window.__wasdPlay.popup.closed", true))


## Closes the sign-in window when it is still open.
func close_popup() -> void:
	if available:
		JavaScriptBridge.eval("if (window.__wasdPlay.popup && !window.__wasdPlay.popup.closed) {" \
				+ " window.__wasdPlay.popup.close(); } window.__wasdPlay.popup = null;", true)


## The path of the page that runs the game, such as /games/<id>/versions/3/index.html.
func location_path() -> String:
	return str(JavaScriptBridge.eval("location.pathname", true)) if available else ""


func _on_message(arguments: Array) -> void:
	if arguments.is_empty():
		return
	var parsed: Variant = Tokens.parse_json(str(arguments[0]))
	if not parsed is Dictionary or not parsed.get("data") is Dictionary:
		return
	message.emit(str(parsed.get("from", "")), str(parsed.get("origin", "")), parsed.get("data"))
