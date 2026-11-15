# SPDX-License-Identifier: CC0-1.0
# The lobby signal socket: JSON text messages to and from the WASD lobby service, which passes WebRTC offers, answers,
# and network candidates between a lobby's host and each joiner. The owner calls poll() every frame.
extends RefCounted

## The socket opened.
signal opened
## A JSON object arrived.
signal received(message: Dictionary)
## The socket closed. [param code] is the WebSocket close code (-1 when the connection never opened).
signal closed(code: int, reason: String)

const Tokens := preload("tokens.gd")
const PING_SECONDS := 20.0

var _socket := WebSocketPeer.new()
var _state := WebSocketPeer.STATE_CLOSED
var _last_ping := 0.0
var _was_open := false


## Starts connecting to [param url], which carries the signal ticket. The URL is never printed.
func open(url: String) -> Error:
	_socket = WebSocketPeer.new()
	_socket.inbound_buffer_size = 1 << 17
	_socket.outbound_buffer_size = 1 << 17
	_was_open = false
	var error := _socket.connect_to_url(url)
	_state = _socket.get_ready_state() if error == OK else WebSocketPeer.STATE_CLOSED
	return error


## True while the socket is open.
func is_open() -> bool:
	return _state == WebSocketPeer.STATE_OPEN


## True while the socket is connecting or open.
func is_active() -> bool:
	return _state == WebSocketPeer.STATE_CONNECTING or _state == WebSocketPeer.STATE_OPEN


## Sends one message when the socket is open; returns false otherwise.
func send(message: Dictionary) -> bool:
	if _state != WebSocketPeer.STATE_OPEN:
		return false
	return _socket.send_text(JSON.stringify(message)) == OK


## Closes the socket without emitting closed.
func close() -> void:
	if _state == WebSocketPeer.STATE_OPEN or _state == WebSocketPeer.STATE_CONNECTING:
		_socket.close(1000, "leaving")
	_state = WebSocketPeer.STATE_CLOSED


## Reads arrived messages, keeps the socket alive, and reports state changes. [param now] is in seconds. Messages
## that arrived before the socket closed are delivered before closed, such as the error the lobby service sends just
## before it turns a player away.
func poll(now: float) -> void:
	if _state == WebSocketPeer.STATE_CLOSED:
		return
	_socket.poll()
	var state := _socket.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN and not _was_open:
		_was_open = true
		_last_ping = now
		_state = state
		opened.emit()
	if _was_open:
		while _state != WebSocketPeer.STATE_CLOSED and _socket.get_available_packet_count() > 0:
			var packet := _socket.get_packet()
			if not _socket.was_string_packet():
				continue
			var parsed: Variant = Tokens.parse_json(packet.get_string_from_utf8())
			if parsed is Dictionary:
				received.emit(parsed)
		if _state == WebSocketPeer.STATE_CLOSED:
			return
	if state == WebSocketPeer.STATE_OPEN:
		if now - _last_ping >= PING_SECONDS:
			_last_ping = now
			send({"type": "ping"})
	elif state == WebSocketPeer.STATE_CLOSED:
		var code := _socket.get_close_code() if _was_open else -1
		var reason := _socket.get_close_reason()
		_state = state
		closed.emit(code, reason)
		return
	_state = state
