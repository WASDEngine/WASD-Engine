# SPDX-License-Identifier: CC0-1.0
# JSON requests to the WASD play API. Every call resolves to {"ok": true, "status", "data"} or to
# {"ok": false, "error": <code>, "message", "status", ...}, where extra fields of the service's error body (such as
# lobby_version, server_version, or reason) are copied in.
extends RefCounted

const Tokens := preload("tokens.gd")

## The API origin, such as https://app.wasdengine.com.
var origin := ""

var _host: Node


func _init(host: Node) -> void:
	_host = host


## Sends one request. [param body] is sent as JSON unless it is null; [param token] goes in the Authorization header.
func request(method: int, path: String, body: Variant = null, token := "", timeout := 15.0) -> Dictionary:
	if origin == "":
		return {"ok": false, "error": "no_api_origin", "message": "The WASD API origin is not set.", "status": 0}
	var http := HTTPRequest.new()
	http.timeout = timeout
	http.accept_gzip = true
	# A redirect would carry the Authorization header to wherever it points; the WASD API never redirects.
	http.max_redirects = 0
	_host.add_child(http)
	var headers := PackedStringArray(["Accept: application/json"])
	if token != "":
		headers.append("Authorization: Bearer " + token)
	var data := ""
	if body != null:
		headers.append("Content-Type: application/json")
		data = JSON.stringify(body)
	var started := http.request(origin + path, headers, method, data)
	if started != OK:
		http.queue_free()
		return {"ok": false, "error": "network", "status": 0,
				"message": "The request to the WASD service could not start (error %d)." % started}
	var result: Array = await http.request_completed
	http.queue_free()
	var outcome: int = result[0]
	var status: int = result[1]
	var text := (result[3] as PackedByteArray).get_string_from_utf8()
	if outcome != HTTPRequest.RESULT_SUCCESS:
		var reason := "timed out" if outcome == HTTPRequest.RESULT_TIMEOUT else "failed (result %d)" % outcome
		return {"ok": false, "error": "network", "status": 0,
				"message": "The request to the WASD service %s. Check the internet connection." % reason}
	var parsed: Variant = Tokens.parse_json(text) if text != "" else {}
	if status >= 200 and status < 300:
		return {"ok": true, "status": status, "data": parsed if parsed is Dictionary else {}}
	return _failure(status, parsed)


static func _failure(status: int, parsed: Variant) -> Dictionary:
	var failure := {"ok": false, "status": status, "error": _default_code(status),
			"message": "The WASD service answered %d." % status}
	if not parsed is Dictionary:
		return failure
	var body: Dictionary = parsed
	var error: Variant = body.get("error")
	for key in body:
		if key != "error" and key != "type" and key != "ok":
			failure[key] = body[key]
	if error is Dictionary:
		for key in error:
			if key != "type" and key != "message":
				failure[key] = error[key]
		if str(error.get("type", "")) != "":
			failure["error"] = str(error.get("type"))
		if str(error.get("message", "")) != "":
			failure["message"] = str(error.get("message"))
	elif error is String and error != "":
		failure["error"] = error
	if body.get("code") is String and body.get("code") != "":
		failure["error"] = body.get("code")
	if body.get("message") is String and body.get("message") != "":
		failure["message"] = body.get("message")
	failure["ok"] = false
	failure["status"] = status
	return failure


static func _default_code(status: int) -> String:
	match status:
		401:
			return "signed_out"
		403:
			return "forbidden"
		404:
			return "not_found"
		409:
			return "conflict"
		429:
			return "rate_limited"
		503:
			return "unavailable"
	return "server_error" if status >= 500 else "request_failed"
