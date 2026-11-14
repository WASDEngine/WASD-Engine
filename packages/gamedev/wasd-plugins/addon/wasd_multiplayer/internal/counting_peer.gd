# SPDX-License-Identifier: CC0-1.0
# A MultiplayerPeer that passes everything to another one and counts what it carries, for stats(). Counts are of
# multiplayer payloads: a packet sent to every peer counts once per receiving peer, and transport overhead (WebSocket,
# TLS, DTLS, IP headers) is not included; packets_in and packets_out let a caller add a per-packet estimate.
extends MultiplayerPeerExtension

## The peer that carries the traffic.
var inner: MultiplayerPeer
## Payload bytes received.
var bytes_in := 0
## Payload bytes sent, once per receiving peer.
var bytes_out := 0
## Packets received.
var packets_in := 0
## Packets sent, once per receiving peer.
var packets_out := 0

var _target := 0
var _peers := {}


func _init(p_inner: MultiplayerPeer) -> void:
	inner = p_inner
	inner.peer_connected.connect(_on_peer_connected)
	inner.peer_disconnected.connect(_on_peer_disconnected)


func _on_peer_connected(id: int) -> void:
	_peers[id] = true
	peer_connected.emit(id)


func _on_peer_disconnected(id: int) -> void:
	_peers.erase(id)
	peer_disconnected.emit(id)


func _get_packet_script() -> PackedByteArray:
	var packet := inner.get_packet()
	bytes_in += packet.size()
	packets_in += 1
	return packet


func _put_packet_script(buffer: PackedByteArray) -> Error:
	var copies := 1
	if _target == 0:
		copies = maxi(_peers.size(), 1)
	elif _target < 0:
		copies = maxi(_peers.size() - 1, 0)
	bytes_out += buffer.size() * copies
	packets_out += copies
	return inner.put_packet(buffer)


func _get_available_packet_count() -> int:
	return inner.get_available_packet_count()


func _get_max_packet_size() -> int:
	return 1 << 20


func _get_packet_channel() -> int:
	return inner.get_packet_channel()


func _get_packet_mode() -> MultiplayerPeer.TransferMode:
	return inner.get_packet_mode()


func _get_packet_peer() -> int:
	return inner.get_packet_peer()


func _set_transfer_channel(channel: int) -> void:
	inner.transfer_channel = channel


func _get_transfer_channel() -> int:
	return inner.transfer_channel


func _set_transfer_mode(transfer_mode: MultiplayerPeer.TransferMode) -> void:
	inner.transfer_mode = transfer_mode


func _get_transfer_mode() -> MultiplayerPeer.TransferMode:
	return inner.transfer_mode


func _set_target_peer(peer: int) -> void:
	_target = peer
	inner.set_target_peer(peer)


func _is_server() -> bool:
	return inner.get_unique_id() == 1


func _poll() -> void:
	inner.poll()


func _close() -> void:
	inner.close()


func _disconnect_peer(peer: int, force: bool) -> void:
	inner.disconnect_peer(peer, force)


func _get_unique_id() -> int:
	return inner.get_unique_id()


func _set_refuse_new_connections(enable: bool) -> void:
	inner.refuse_new_connections = enable


func _is_refusing_new_connections() -> bool:
	return inner.refuse_new_connections


func _is_server_relay_supported() -> bool:
	return inner.is_server_relay_supported()


func _get_connection_status() -> MultiplayerPeer.ConnectionStatus:
	return inner.get_connection_status()
