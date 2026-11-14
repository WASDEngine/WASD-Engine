# SPDX-License-Identifier: CC0-1.0
# Signed WASD tokens, "<prefix>.<payload>.<signature>": the payload is base64url JSON and the signature is the
# base64url HMAC-SHA256 of "<prefix>.<payload>", both without padding. Player tokens ("wpt1") are checked by the
# WASD service; game servers check join tickets ("wjt1") with their own key. Never print a token or a key.
extends RefCounted

const _URL_SAFE := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


## Decodes unpadded base64url text, or returns an empty array when the text is not base64url.
static func b64url_decode(text: String) -> PackedByteArray:
	if text.is_empty():
		return PackedByteArray()
	for character in text:
		if not _URL_SAFE.contains(character):
			return PackedByteArray()
	var standard := text.replace("-", "+").replace("_", "/")
	match standard.length() % 4:
		1:
			return PackedByteArray()
		2:
			standard += "=="
		3:
			standard += "="
	return Marshalls.base64_to_raw(standard)


## Encodes bytes as unpadded base64url text.
static func b64url_encode(data: PackedByteArray) -> String:
	return Marshalls.raw_to_base64(data).replace("+", "-").replace("/", "_").replace("=", "")


## Parses JSON text without printing errors; returns null when the text is not JSON. Whole numbers become ints, so
## counts and versions compare and format as integers.
static func parse_json(text: String) -> Variant:
	var json := JSON.new()
	if json.parse(text) != OK:
		return null
	return _whole_numbers(json.data)


static func _whole_numbers(value: Variant) -> Variant:
	if value is float:
		var number: float = value
		if number == floorf(number) and absf(number) < 9.0e15:
			return int(number)
		return number
	if value is Dictionary:
		var copy := {}
		for key in value:
			copy[key] = _whole_numbers(value[key])
		return copy
	if value is Array:
		var items := []
		for item in value:
			items.append(_whole_numbers(item))
		return items
	return value


## The payload of a token as a Dictionary, without checking its signature, or {} when it cannot be read.
static func payload(token: String) -> Dictionary:
	var parts := token.split(".")
	if parts.size() != 3:
		return {}
	var raw := b64url_decode(parts[1])
	if raw.is_empty():
		return {}
	var parsed: Variant = parse_json(raw.get_string_from_utf8())
	return parsed if parsed is Dictionary else {}


## The payload of a token whose prefix, signature, and expiry check out, or {} when any of them does not.
## [param key] is the raw HMAC key; [param now] is the current Unix time in seconds.
static func verify(token: String, prefix: String, key: PackedByteArray, now: float) -> Dictionary:
	if key.is_empty() or token.length() > 4096:
		return {}
	var parts := token.split(".")
	if parts.size() != 3 or parts[0] != prefix:
		return {}
	var given := b64url_decode(parts[2])
	var crypto := Crypto.new()
	var expected := crypto.hmac_digest(HashingContext.HASH_SHA256, key, (parts[0] + "." + parts[1]).to_utf8_buffer())
	if given.size() != expected.size() or not crypto.constant_time_compare(expected, given):
		return {}
	var data := payload(token)
	if data.is_empty() or float(data.get("exp", 0)) <= now:
		return {}
	return data


## Signs a payload the way the WASD service does. Used by test runs only.
static func sign(prefix: String, data: Dictionary, key: PackedByteArray) -> String:
	var body := b64url_encode(JSON.stringify(data).to_utf8_buffer())
	var signature := Crypto.new().hmac_digest(HashingContext.HASH_SHA256, key, (prefix + "." + body).to_utf8_buffer())
	return "%s.%s.%s" % [prefix, body, b64url_encode(signature)]


## The value of one query parameter of a URL, URL-decoded, or "" when the URL has none.
static func query_param(url: String, name: String) -> String:
	var question := url.find("?")
	if question < 0:
		return ""
	var query := url.substr(question + 1)
	var hash := query.find("#")
	if hash >= 0:
		query = query.substr(0, hash)
	for pair in query.split("&", false):
		var equals := pair.find("=")
		var key := pair if equals < 0 else pair.substr(0, equals)
		if key == name:
			return "" if equals < 0 else pair.substr(equals + 1).uri_decode()
	return ""
