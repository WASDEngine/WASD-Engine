// WASD Engine worker class for the headless SuperCollider tools (packages/gamedev/supercollider).
//
// The bridge process (src/bridge.ts) adds this file's folder to sclang's class library and drives sclang through its
// terminal input, one command per ESC (0x1b) byte: WasdWorker.boot once, then WasdWorker.dispatch once per request.
// Parameters arrive as JSON files, because sclang string literals hold at most 8191 bytes; the class deletes each file
// after reading it. Replies are single lines of post output that start a new line with the bridge's token:
//
//   <token> READY <JSON object>
//   <token> END <request id> {"ok": true, "result": <JSON>} or {"ok": false, "error": {"type", "message", "traceback"}}
//
// Requests run one at a time inside a Routine on the AppClock, so a handler can wait for an offline render.
// sclang's JSON parser returns every scalar as a String, so the handlers convert numbers and booleans themselves.
// Real-time servers stay off: there is no audio device, and every render runs scsynth in non-real-time mode.

WasdWorker {
	classvar token, scsynth, plugins, scratch, helpSource, count = 0;

	*boot { |tokenArg, path|
		var params = this.prReadParams(path);
		token = tokenArg;
		scsynth = params["scsynth"];
		plugins = params["plugins"];
		scratch = params["scratch"];
		helpSource = params["helpSource"] ?? { SCDoc.helpSourceDir };
		Score.program = "exec %".format(scsynth.shellQuote);
		this.prPost("READY", nil, (version: Main.version, helpSource: helpSource));
	}

	*dispatch { |id, method, path|
		Routine {
			this.prPost("END", id, this.prHandle(method, path));
		}.play(AppClock);
	}

	*prHandle { |method, path|
		var params, handler, result;
		^try {
			params = this.prReadParams(path);
			handler = ("method_" ++ method).asSymbol;
			if(this.respondsTo(handler).not) { Error("The SuperCollider worker has no method %.".format(method)).throw };
			result = this.perform(handler, params);
			(ok: true, result: result)
		} { |error|
			(ok: false, error: (type: error.class.name.asString, message: this.prErrorMessage(error), traceback: this.prErrorDetail(error)))
		}
	}

	*prReadParams { |path|
		var text = File.readAllString(path);
		File.delete(path);
		^text.parseJSON
	}

	*prPost { |kind, id, value|
		var line = CollStream.on(String.new);
		line << Char.nl << token << " " << kind;
		if(id.notNil) { line << " " << id };
		line << " ";
		this.prWriteJSON(value, line);
		line.contents.postln;
	}

	// Error text without the "ERROR: " prefix that errorString adds.
	*prErrorMessage { |error|
		var text = error.errorString;
		^if(text.beginsWith("ERROR: ")) { text.drop(7) } { text }
	}

	// What a method error adds to its message: the receiver and, for a message not understood, the arguments.
	*prErrorDetail { |error|
		var detail = CollStream.on(String.new);
		if(error.isKindOf(MethodError).not) { ^"" };
		detail << "receiver: " << this.prDescribe(error.receiver, 300);
		if(error.isKindOf(DoesNotUnderstandError)) { detail << "\narguments: " << this.prDescribe(error.args, 300) };
		^detail.contents
	}

	// A value as code, at most limit characters; objects whose code form fails fall back to their name.
	*prDescribe { |value, limit|
		var text = try { value.asCompileString } { try { value.asString } { value.class.name.asString } };
		^if(text.size > limit) { text.keep(limit) ++ " ...(" ++ (text.size - limit) ++ " more characters)" } { text }
	}

	*prWriteJSON { |value, stream|
		case
		{ value.isNil } { stream << "null" }
		{ value === true } { stream << "true" }
		{ value === false } { stream << "false" }
		{ value.isKindOf(Integer) } { stream << value.asString }
		{ value.isKindOf(Float) } {
			if(value.isNaN or: { value.abs == inf }) { stream << "null" } { stream << value.asStringPrec(17) }
		}
		{ value.isKindOf(Symbol) or: { value.isString } } { this.prWriteJSONString(value.asString, stream) }
		{ value.isKindOf(Dictionary) } {
			var first = true;
			stream << "{";
			value.keysValuesDo { |key, item|
				if(first.not) { stream << "," };
				first = false;
				this.prWriteJSONString(key.asString, stream);
				stream << ":";
				this.prWriteJSON(item, stream);
			};
			stream << "}";
		}
		{ value.isKindOf(SequenceableCollection) } {
			stream << "[";
			value.do { |item, index|
				if(index > 0) { stream << "," };
				this.prWriteJSON(item, stream);
			};
			stream << "]";
		}
		{ this.prWriteJSONString(value.asString, stream) };
	}

	// Escapes quotes, backslashes, and control characters; bytes of multibyte UTF-8 characters pass unchanged.
	*prWriteJSONString { |string, stream|
		stream << $";
		string.do { |char|
			var code = char.ascii;
			case
			{ char == $" } { stream << "\\\"" }
			{ char == $\\ } { stream << "\\\\" }
			{ code >= 0 and: { code < 32 } } { stream << "\\u" << code.asHexString(4) }
			{ stream << char };
		};
		stream << $";
	}

	*prScratchFile { |name|
		count = count + 1;
		^scratch +/+ "%-%-%".format(token, count, name)
	}

	*prNumber { |params, key|
		var value = params[key];
		^if(value.isNil) { nil } { value.asFloat }
	}

	// execute_sclang: run code as the body of a function; reply with the value of its last expression as code.
	*method_execute_sclang { |params|
		var started = Main.elapsedTime, function, value, failure;
		function = params["code"].compile;
		if(function.isNil) {
			^(result: nil, resultClass: nil, seconds: nil,
				error: (type: "SyntaxError", message: "The code did not compile; the output shows where.", traceback: ""))
		};
		value = try { function.value } { |error| failure = error; nil };
		^if(failure.notNil) {
			(result: nil, resultClass: nil, seconds: Main.elapsedTime - started,
				error: (type: failure.class.name.asString, message: this.prErrorMessage(failure), traceback: this.prErrorDetail(failure)))
		} {
			(result: if(value.isNil) { nil } { this.prDescribe(value, 20000) }, resultClass: value.class.name.asString,
				seconds: Main.elapsedTime - started, error: nil)
		}
	}

	// render_audio: evaluate code to a function, SynthDef, pattern, Score, or score list, render it offline as 32-bit
	// float WAV, then write exactly duration seconds of it to path in the requested format, scaled by the
	// normalization gain. The float render stays in the scratch folder for the server's analysis, which deletes it.
	*method_render_audio { |params|
		var duration = params["duration"].asFloat, sampleRate = params["sample_rate"].asInteger;
		var channels = params["channels"] !? { |value| value.asInteger }, normalizeDb = this.prNumber(params, "normalize_db");
		var path = params["path"], function, value, plan, raw, frames, peak, gain = 1.0;
		function = params["code"].compile;
		if(function.isNil) { Error("The code did not compile; the output shows where.").throw };
		value = function.value;
		plan = this.prScore(value, duration, channels);
		raw = this.prScratchFile("render.wav");
		this.prRenderNRT(plan[\score], raw, plan[\channels], sampleRate, duration);
		frames = (duration * sampleRate).round.asInteger;
		peak = this.prPeak(raw, frames);
		if(normalizeDb.notNil and: { peak > 0 }) { gain = normalizeDb.dbamp / peak };
		File.mkdir(path.dirname);
		this.prConvert(raw, path, params["header_format"], params["sample_format"], frames, gain);
		^(
			path: path, raw: raw, frames: frames, channels: plan[\channels], sampleRate: sampleRate,
			headerFormat: params["header_format"], sampleFormat: params["sample_format"], gain: gain,
			source: plan[\source], bytes: File.fileSize(path)
		)
	}

	// A Score of the value, the channel count to record, and what the value was.
	*prScore { |value, duration, channels|
		var events, recorded, source, defs;
		case
		{ value.isKindOf(Function) or: { value.isKindOf(SynthDef) } } {
			var def, outputs, rates;
			source = if(value.isKindOf(Function)) { "function" } { "SynthDef" };
			if(value.isKindOf(Function)) {
				def = SynthDef(("wasd_render_" ++ (count + 1)).asSymbol, {
					var signal = SynthDef.wrap(value);
					var writes = UGen.buildSynthDef.children.any { |ugen| ugen.isKindOf(AbstractOut) };
					if(writes.not) {
						signal = signal.asArray.flat;
						rates = signal.collect { |item| if(item.respondsTo(\rate)) { item.rate } { item.class.name } }.asSet;
						rates.remove(\audio);
						if(signal.isEmpty) {
							Error("The function returned no signal: end it with an audio-rate signal such as SinOsc.ar(440), or write to Out.ar yourself.").throw
						};
						if(rates.notEmpty) {
							Error("The function returned % signals, which a file cannot record: end it with audio-rate (.ar) UGens such as SinOsc.ar(440), or write to Out.ar yourself.".format(rates.asArray.collect { |rate| "%-rate".format(rate) }.join(" and "))).throw
						};
						outputs = signal.size;
						if(channels.notNil and: { outputs == 1 } and: { channels > 1 }) { signal = signal.wrapExtend(channels); outputs = channels };
						Out.ar(0, signal);
					};
				});
			} {
				def = value;
				if(def.children.any { |ugen| ugen.isKindOf(AbstractOut) }.not) {
					Error("The SynthDef % writes to no Out UGen, so it renders silence.".format(def.name)).throw
				};
			};
			if(channels.notNil and: { outputs.notNil } and: { channels != outputs }) {
				Error("The function outputs % channels; omit channels or set it to %.".format(outputs, outputs)).throw
			};
			recorded = channels ? outputs ? 2;
			events = [[0.0, [\d_recv, def.asBytes]], [0.0, [\s_new, def.name, 1000, 0, 0]]];
		}
		{ value.isKindOf(Pattern) } {
			source = "pattern";
			events = value.asScore(duration).score;
			recorded = channels ? 2;
		}
		{ value.isKindOf(Score) } {
			source = "Score";
			events = value.score;
			recorded = channels ? 2;
		}
		{ value.isKindOf(SequenceableCollection) and: { value.every { |event| event.isKindOf(SequenceableCollection) } } } {
			source = "score list";
			events = Score(value).score;
			recorded = channels ? 2;
		}
		{
			Error("render_audio renders a UGen graph function, a SynthDef, a pattern, or a Score; the code returned %.".format(this.prDescribe(value, 200))).throw
		};
		// Patterns and scores play SynthDefs by name: send every SynthDef that SynthDescLib knows, before any event.
		defs = if(source == "function" or: { source == "SynthDef" }) { [] } {
			SynthDescLib.global.synthDescs.values.select { |desc| desc.def.notNil }.collect { |desc| [0.0, [\d_recv, desc.def.asBytes]] }.asArray
		};
		events = events.select { |event| event[0] >= 0 and: { event[0] <= duration } }.sort { |a, b| a[0] <= b[0] };
		^(score: defs ++ events ++ [[duration, [0]]], channels: recorded, source: source)
	}

	*prRenderNRT { |events, output, channels, sampleRate, duration|
		var osc = this.prScratchFile("score.osc"), log = this.prScratchFile("scsynth.log");
		var options = ServerOptions.new.numOutputBusChannels_(channels).numInputBusChannels_(0).sampleRate_(sampleRate)
			.memSize_(2 ** 18).maxSynthDefs_(4096);
		var condition = Condition.new, exitCode, command, text;
		if(plugins.notNil) { options.ugenPluginsPath = plugins };
		this.prWriteScore(events, osc);
		command = "exec % -N % _ % % WAV float %".format(scsynth.shellQuote, osc.shellQuote, output.shellQuote, sampleRate,
			options.asOptionsString) ++ " > " ++ log.shellQuote ++ " 2>&1";
		command.unixCmd({ |code| exitCode = code; condition.test = true; condition.signal }, false);
		condition.wait;
		text = if(File.exists(log)) { File.readAllString(log) } { "" };
		File.delete(osc);
		File.delete(log);
		text = text.split(Char.nl).reject { |line| line.isEmpty or: { line.beginsWith("start time") } or: { line.beginsWith("nextOSCPacket") } }.join("\n");
		if(text.notEmpty) { ("scsynth: " ++ text).postln };
		if(exitCode != 0) { Error("scsynth stopped with exit code % while rendering.".format(exitCode)).throw };
		if(File.exists(output).not) { Error("scsynth finished without writing audio.").throw };
	}

	// Score.write without its tempo scaling: event times are seconds whatever TempoClock.default's tempo is.
	*prWriteScore { |events, path|
		var file = File(path, "w"), bytes;
		if(file.isOpen.not) { Error("Cannot write the score file %.".format(path)).throw };
		protect {
			events.do { |event| bytes = event.asRawOSC; file.write(bytes.size).write(bytes) };
		} { file.close };
	}

	// Largest absolute sample in the first frames of a float file.
	*prPeak { |path, frames|
		var file = SoundFile.openRead(path), peak = 0.0, remaining, data;
		if(file.isNil) { Error("The rendered audio % cannot be read.".format(path)).throw };
		remaining = min(frames, file.numFrames) * file.numChannels;
		protect {
			while { remaining > 0 } {
				data = FloatArray.newClear(min(65536 * file.numChannels, remaining));
				file.readData(data);
				if(data.isEmpty) { remaining = 0 } {
					peak = max(peak, data.abs.maxItem);
					remaining = remaining - data.size;
				};
			};
		} { file.close };
		^peak
	}

	// Copy the first frames of source to path in the given header and sample format, multiplied by gain.
	*prConvert { |source, path, headerFormat, sampleFormat, frames, gain|
		var input = SoundFile.openRead(source), output, remaining, data;
		if(input.isNil) { Error("The audio % cannot be read.".format(source)).throw };
		output = SoundFile.new.headerFormat_(headerFormat).sampleFormat_(sampleFormat)
			.numChannels_(input.numChannels).sampleRate_(input.sampleRate);
		if(output.openWrite(path).not) {
			input.close;
			Error("Cannot write % as % with % samples.".format(path, headerFormat, sampleFormat)).throw
		};
		remaining = min(frames, input.numFrames) * input.numChannels;
		protect {
			while { remaining > 0 } {
				data = FloatArray.newClear(min(65536 * input.numChannels, remaining));
				input.readData(data);
				if(data.isEmpty) { remaining = 0 } {
					if(gain != 1.0) { data = (data * gain).as(FloatArray) };
					output.writeData(data);
					remaining = remaining - data.size;
				};
			};
		} { input.close; output.close };
	}

	// decode_audio: describe an audio file and copy a window of it, at most max_seconds long, to a float WAV in the
	// scratch folder for the server's analysis, which deletes it.
	*method_decode_audio { |params|
		var path = params["path"], start = this.prNumber(params, "start") ? 0, end = this.prNumber(params, "end");
		var maxSeconds = params["max_seconds"].asFloat, file, first, last, output, copy, remaining, data;
		file = SoundFile.openRead(path);
		if(file.isNil) {
			Error(if(File.exists(path)) { "% is not an audio file that SuperCollider can read.".format(path) } { "% does not exist.".format(path) }).throw
		};
		protect {
			first = (start * file.sampleRate).round.asInteger.clip(0, file.numFrames);
			last = if(end.isNil) { file.numFrames } { (end * file.sampleRate).round.asInteger.clip(first, file.numFrames) };
			if(last - first > (maxSeconds * file.sampleRate)) {
				Error("The window holds % s of audio; choose start and end at most % s apart.".format(((last - first) / file.sampleRate).round(0.01), maxSeconds)).throw
			};
			output = this.prScratchFile("decode.wav");
			copy = SoundFile.openWrite(output, "WAV", "float", file.numChannels, file.sampleRate);
			if(copy.isNil) { Error("Cannot write the analysis copy %.".format(output)).throw };
			file.seek(first, 0);
			remaining = (last - first) * file.numChannels;
			protect {
				while { remaining > 0 } {
					data = FloatArray.newClear(min(65536 * file.numChannels, remaining));
					file.readData(data);
					if(data.isEmpty) { remaining = 0 } {
						copy.writeData(data);
						remaining = remaining - data.size;
					};
				};
			} { copy.close };
		} { file.close };
		^(
			path: path, raw: output, headerFormat: file.headerFormat, sampleFormat: file.sampleFormat,
			channels: file.numChannels, sampleRate: file.sampleRate, frames: file.numFrames, firstFrame: first, lastFrame: last,
			bytes: File.fileSize(path)
		)
	}

	// class_info: method signatures, superclasses, and help files of named classes, or class names that contain a query.
	*method_class_info { |params|
		var names = params["names"], search = params["search"], limit = params["limit"].asInteger, query, matches;
		if(search.notNil) {
			query = search.toLower;
			matches = Class.allClasses.select { |class| class.isMetaClass.not and: { class.name.asString.toLower.contains(query) } };
			^(matches: matches.keep(limit).collect { |class| (name: class.name.asString, helpFile: this.prHelpFile(class)) },
				total: matches.size, helpSource: helpSource)
		};
		^(classes: names.collect { |name| this.prClassInfo(name) }, helpSource: helpSource)
	}

	*prClassInfo { |name|
		var class = name.asSymbol.asClass;
		if(class.isNil or: { class.isMetaClass }) { ^(name: name, found: false) };
		^(
			name: class.name.asString, found: true, superclasses: class.superclasses.collect { |each| each.name.asString },
			classMethods: this.prSignatures(class.class), instanceMethods: this.prSignatures(class),
			helpFile: this.prHelpFile(class), file: class.filenameSymbol.asString
		)
	}

	*prHelpFile { |class|
		var file = helpSource +/+ "Classes" +/+ class.name.asString ++ ".schelp";
		^if(File.exists(file)) { file } { nil }
	}

	// Public methods that the class itself defines, as name(argument: default, ...), sorted by name.
	*prSignatures { |class|
		^(class.methods ? []).reject { |method| method.name.asString.beginsWith("pr") }
			.collect { |method| this.prSignature(method) }.sort
	}

	*prSignature { |method|
		var names = method.argNames ? [], defaults = method.prototypeFrame ? [];
		var parts = names.drop(1).collect { |argName, index|
			var default = defaults[index + 1];
			case
			{ method.varArgs and: { index == (names.size - 2) } } { "... " ++ argName }
			{ default.isNil } { argName.asString }
			{ argName.asString ++ ": " ++ this.prDescribe(default, 60) }
		};
		^method.name.asString ++ "(" ++ parts.join(", ") ++ ")"
	}
}

// No audio device: refuse to boot a real-time server instead of opening the machine's audio output.
+ Server {
	boot { |startAliveThread = true, recover = false, onFailure|
		Error("This SuperCollider runs without an audio device, so a real-time server cannot boot. Render sound to a file with render_audio, which runs scsynth offline.").throw
	}
}
