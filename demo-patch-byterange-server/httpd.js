"use strict";

const http = require('http');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const path = require('path');

http.createServer(handleRequest).listen(8080, function(){
	console.log('<http://localhost:8080/>');
});

async function handleRequest(req, res){
	const filepath = path.normalize(path.resolve(__dirname, req.url.slice(1)));
	if(!filepath.startsWith(__dirname)){
		res.statusCode = 400;
		res.end();
		return;
	}

	if(filepath===__dirname || filepath===__dirname+'/client.xhtml'){
		if(req.method === 'GET'){
			res.statusCode = 200;
			res.setHeader('Content-Type', 'application/xhtml+xml');
			const read = createReadStream(__dirname+'/client.xhtml');
			read.pipe(res);
		}else{
			res.statusCode = 405;
			res.setHeader('Content-Type', 'text/plain');
			res.end('Method not allowed: '+req.method+'\r\n');
		}
		return;
	}


	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Access-Control-Allow-Origin', '*');

	const fp = await fs.open(filepath, 'r').catch(function(err){
		// Ignore ENOENT errors
		if(err.code !== 'ENOENT') throw err;
	});
	try {
		if(req.method === 'GET'){
			await handleGet(req, res, filepath, fp);
		}else if(req.method === 'PUT'){
			await handlePut(req, res, filepath, fp);
		}else if(req.method === 'PATCH'){
			await handlePatch(req, res, filepath, fp);
		}else{
			res.statusCode = 405;
			res.setHeader('Content-Type', 'text/plain');
			res.end('Method not allowed: '+req.method+'\r\n');
			return;
		}
	}catch(err){
		res.statusCode = 500;
		res.setHeader('Content-Type', 'text/plain');
		res.end(err.stack+'\r\n');
		console.error(err.stack);
		return;
	}finally{
		if(fp) fp.close();
		console.log(req.method + ' ' + filepath + ' ' + res.statusCode);
	}
}

async function handleGet(req, res, filepath, fp){
	if(!fp){
		res.statusCode = 404;
		res.setHeader('Content-Type', 'text/plain');
		res.end('File not found: '+filepath+'\r\n');
		return;	
	}
	const stat = await fp.stat();
	fp = await fs.open(filepath, 'r');
	if(!fp) throw new Error();

	if(stat.size === 0){
		// If the file size is zero, this makes byte range selections impossible
		// e.g. 0-0 still selects one byte
		res.setHeader('Content-Type', 'application/octet-stream');
		res.setHeader('Content-Length', '0');
		res.end();
		return;
	}

	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Length', stat.size+'');
	if(req.headers['range']){
		// Parse range header

	}else{
		res.flushHeaders();
		// const read = fp.createReadStream({start:0, end:stat.size-1});
		const read = fp.createReadStream({});
		read.pipe(res);
	}
}

async function handlePut(req, res, filepath){
	if(req.headers['content-type'] === 'application/octet-stream'){
		// re-create the file, truncate it if it exists
		var fp = await fs.open(filepath, 'w');
		// fp.truncate(0);
		const writeStream = fp.createWriteStream();
		req.pipe(writeStream);
		return;
	}else{
		res.statusCode = 415;
		res.setHeader('Content-Type', 'text/plain');
		res.end('Unsupported media type. Supported media types:\r\napplication/octet-stream\r\n');
		return;
	}
}

async function handlePatch(req, res, filepath){
	// This is the core of the patch handling code
	try {
		if(req.headers['content-type'] === 'message/byterange'){
			await handlePatchMessageByterange(req, filepath);
		}else if(req.headers['content-type'] === 'multipart/byteranges'){
			await handlePatchMultipartByterange(req, filepath);
		}else if(req.headers['content-type'] === 'application/byteranges'){
			await handleApplicationByteranges(req, filepath);
		}else{
			res.statusCode = 415;
			res.setHeader('Content-Type', 'text/plain');
			res.end('Unsupported media type. Supported media types:\r\nmessage/byterange\r\nmultipart/byteranges\r\napplication/byteranges\r\n');
			return;
		}
	}catch(err){
		if(err instanceof ReferenceError || err instanceof RangeError) throw err;
		res.statusCode = 400;
		res.setHeader('Content-Type', 'text/plain');
		res.end('Thrown error:\r\n' + err.stack + '\r\n');
		return;
	}
	res.statusCode = 200;
	res.end();
}

async function handlePatchMessageByterange(req, filepath){
	var fields = Buffer.from([]);
	var offset;
	var body;
	for await (const chunk of req) {
		fields = Buffer.concat([fields, chunk]);
		const end = fields.indexOf("\r\n\r\n");
		if(end >= 0){
			body = fields.slice(end+4);
			fields = fields.slice(0, end+4);
		}
	}
	const headersAscii = fields.toString();
	if(!headersAscii.match(/^([!\x23-'\x2a\x2b\x2d\x2e0-9A-Z\x5e-z\x7c~]+:[\t ]*(?:[!-~](?:[\t -~]+[!-~])?)*[\t ]*\r\n)*\r\n/)){
		res.statusCode = 400;
		res.setHeader('Content-Type', 'text/plain');
		res.end('Syntax error.\r\n');
		return;
	}
	const contentRange = headersAscii.match(/^content-range:[\t ]*([!\x23-'\x2a\x2b\x2d\x2e0-9A-Z\x5e-z\x7c~]+) ([0-9]+)-([0-9]+)\/(([0-9]+)|\*)[\t ]*$/im);
	offset = parseInt(contentRange[2], 10);

	// reopen the file for writing, append if exists, create if not exists
	var fp = await fs.open(filepath, 'a');
	const writeStream = fp.createWriteStream({start: offset});
	writeStream.write(body);
	req.pipe(writeStream);
	req.once('end', function(){ fp.close(); });
	return new Promise(function(resolve, reject){ writeStream.once('close', resolve); writeStream.once('error', reject); });
}

async function handlePatchMultipartByterange(req, filepath){
	var fields = "";
	var si = 0;
	var state = 0;
	var boundary_state = 0;
	// *(*text CRLF) dash-boundary
	const s_preamble_text_or_dash_boundary = si++;
	const s_preamble_text_or_CR = si++;
	const s_preamble_CRLF = si++;
	const s_0dashboundary_1 = si++;
	const s_0dashboundary_boundary = si++; // DIGIT / ALPHA / '()+_,-./:=?
	const s_0dashboundary_padding = si++;
	const s_0dashboundary_CRLF = si++;
	const s_message_field_start_or_CR = si++;
	const s_message_field_or_CR = si++;
	const s_message_field_CRLF = si++;
	const s_message_fields_CRLF = si++;
	const s_message_body_or_delimiter_CR = si++;
	const s_message_body_or_delimiter_CRLF = si++;
	const s_message_body_or_delimiter_dash = si++;
	const s_message_body_or_delimiter_dashdash = si++;
	const s_message_body_or_delimiter_boundary = si++;
	const s_message_body_or_delimiter_end = si++;
	const s_message_body_or_delimiter_enddash = si++;
	const s_message_body_or_delimiter_endCRLF = si++;
	const s_void = si++;
	const s_names = [ 's_preamble_text_or_dash_boundary', 's_preamble_text_or_CR', 's_preamble_CRLF', 's_0dashboundary_1', 's_0dashboundary_boundary', 's_0dashboundary_padding', 's_0dashboundary_CRLF', 's_message_field_start_or_CR', 's_message_field_or_CR', 's_message_field_CRLF', 's_message_fields_CRLF', 's_message_body', 's_message_body_or_delimiter_LF', 's_message_body_or_delimiter_dash', 's_message_body_or_delimiter_dashdash', 's_message_body_or_delimiter_boundary', 's_message_body_or_delimiter_end', 's_message_body_or_delimiter_enddash', 's_message_body_or_delimiter_CR', 's_message_body_or_delimiter_CRLF', 's_void'];
	var boundary_s = '';
	var boundary = [];
	var body_chunks = [];
	var body_chunks_maybe = [];
	for await (const chunk of req) {
		for(var chunk_byte=0; chunk_byte<chunk.length; chunk_byte++){
			const c = chunk[chunk_byte];
			// console.log(s_names[state], c.toString(16), c<0x20 ? String.fromCharCode(0x2400+c) : String.fromCharCode(c), boundary_state, boundary_s[boundary_state]);
			switch(state){
				case s_preamble_text_or_dash_boundary:
					if(c===0x0D) state = s_preamble_CRLF; // CR
					else if(c===0x2D) state = s_0dashboundary_1; // "-"
					else if(c<=0x1F || c===0x0A || c>=0x7F) throw new Error;
					else state = s_preamble_text_or_dash_boundary;
					break;
				case s_preamble_text_or_CR:
					if(c===0x0A) state = s_preamble_text_or_dash_boundary; // LF
					else throw new Error;
					break;
				case s_preamble_CRLF:
					if(c===0x0A) state = s_preamble_text_or_dash_boundary;
					else throw new Error;
					break;
				case s_0dashboundary_1:
					if(c===0x2D) state = s_0dashboundary_boundary;
					else throw new Error;
					break;
				case s_0dashboundary_boundary:
					// DIGIT / ALPHA / '()+_,-./:=?
					if(c>=0x27 && c<=0x7A && c!==0x2A && c!==0x2A && c!==0x3B && c!==0x3C && c!==0x5B && c!==0x5C && c!==0x5D && c!==0x5E){
						boundary.push(c);
						boundary_s += String.fromCharCode(c);
						if(boundary_s.length > 68) throw new Error;
					}else if(c==0x0D) state = s_0dashboundary_CRLF; // CR
					else throw new Error;
					break;
				case s_0dashboundary_CRLF:
					fields = '';
					if(c===0x0A) state = s_message_field_start_or_CR; // LF
					else throw new Error;
					break;
				case s_message_field_start_or_CR:
					// Once we read a header, a CRLF means the start of a new header and not the end of the headers
					if(c>=0x20 && c<=0x7F) state = s_message_field_or_CR;
					else if(c===0x0D) state = s_message_fields_CRLF; // CR
					else throw new Error;
					fields += String.fromCharCode(c);
					break;
				case s_message_field_or_CR:
					if(c>=0x20 && c<=0x7F) state = s_message_field_or_CR;
					else if(c===0x0D) state = s_message_field_CRLF; // CR
					else throw new Error;
					fields += String.fromCharCode(c);
					break;
				case s_message_field_CRLF:
					if(c===0x0A) state = s_message_field_start_or_CR; // LF
					else throw new Error;
					fields += String.fromCharCode(c);
					break;
				case s_message_fields_CRLF:
					// The end of all of the headers
					if(c===0x0A){ // LF
						fields += String.fromCharCode(c);
						state = s_message_body_or_delimiter_CR;

						// Parse the headers
						const headersAscii = fields.toString();
						fields = '';
						if(!headersAscii.match(/^([!\x23-'\x2a\x2b\x2d\x2e0-9A-Z\x5e-z\x7c~]+:[\t ]*(?:[!-~](?:[\t -~]+[!-~])?)*[\t ]*\r\n)*\r\n/)){
							throw new Error;
						}
						const contentRange = headersAscii.match(/^content-range:[\t ]*([!\x23-'\x2a\x2b\x2d\x2e0-9A-Z\x5e-z\x7c~]+) ([0-9]+)-([0-9]+)\/(([0-9]+)|\*)[\t ]*$/im);
						const chunkStart = parseInt(contentRange[2], 10);
										
						// reopen the file for writing, append if exists, create if not exists
						if(fp) fp.close();
						var fp = await fs.open(filepath, 'a');
						if(writeStream) writeStream.close();
						var writeStream = fp.createWriteStream({start: chunkStart});
					}
					else throw new Error;
					break;
				case s_message_body_or_delimiter_CR:
					if(c===0x0D){
						state = s_message_body_or_delimiter_CRLF; // CR
						write_body_maybe(chunk, chunk_byte);
					}else{
						state = s_message_body_or_delimiter_CR;
						write_body(chunk, chunk_byte);
					}
					break;
				case s_message_body_or_delimiter_CRLF:
					if(c===0x0A){
						state = s_message_body_or_delimiter_dash; // "-"
						write_body_maybe(chunk, chunk_byte);
					}else{
						state = s_message_body_or_delimiter_CR;
						release();
					}
					break;
				case s_message_body_or_delimiter_dash:
					if(c===0x2D){
						state = s_message_body_or_delimiter_dashdash; // "-"
						write_body_maybe(chunk, chunk_byte);
					}else{
						state = s_message_body_or_delimiter_CR;
						release();
					}
					break;
				case s_message_body_or_delimiter_dashdash:
					if(c===0x2D){
						state = s_message_body_or_delimiter_boundary; // LF
						write_body_maybe(chunk, chunk_byte);
					}else{
						state = s_message_body_or_delimiter_CR;
						release();
					}
					break;
				case s_message_body_or_delimiter_boundary:
					if(c === boundary[boundary_state]){
						boundary_state++;
						if(boundary_state===boundary.length){
							state = s_message_body_or_delimiter_end;
							body_chunks_maybe = [];
							writeStream.close();
							writeStream = null;
							boundary_state = 0;
						}else{
							write_body_maybe(chunk, chunk_byte);
						}
					}else{
						state = s_message_body_or_delimiter_CR;
						boundary_state = 0;
						release();
					}
					break;
				case s_message_body_or_delimiter_end:
					if(c===0x0D) state = s_message_body_or_delimiter_endCRLF;
					else if(c===0x2D) state = s_message_body_or_delimiter_enddash;
					else throw new Error('Expected CRLF or "--"');
					break;
				case s_message_body_or_delimiter_endCRLF:
					if(c===0x0A) state = s_message_field_start_or_CR;
					else throw new Error('Expected LF');
					break;
				case s_message_body_or_delimiter_enddash:
					if(c===0x2D) state = s_void;
					else throw new Error;
					break;
				case s_void:
					break;
			}
		}

		// Move all chunks that are all definitely body to output
		// Do it this way to try pass chunks (packets) that resemble the incoming chunks as much as possible
		var lastStream;
		while(body_chunks.length && (body_chunks[0].end===body_chunks[0].chunk.length || body_chunks_maybe.length===0)){
			const chunk_data = body_chunks.shift();
			chunk_data.stream.write(chunk_data.chunk.slice(chunk_data.start, chunk_data.end));
			if(lastStream && lastStream !== chunk_data.stream){
				lastStream.close();
			}
			lastStream = chunk_data.stream;
		}
	}

	function write_body(chunk, chunk_byte){
		const current = body_chunks[body_chunks.length-1];
		if(body_chunks.length===0 || current.chunk!==chunk || (current.chunk===chunk && current.end!==chunk_byte)){
			body_chunks.push({chunk, start:chunk_byte, end:chunk_byte+1, stream:writeStream});
		}else if(current.end === chunk_byte){
			current.end = chunk_byte+1;
		}else{
			throw new Error;
		}
	}

	function write_body_maybe(chunk, chunk_byte){
		const current = body_chunks_maybe[body_chunks_maybe.length-1];
		if(body_chunks_maybe.length===0 || current.chunk!==chunk){
			body_chunks_maybe.push({chunk, start:chunk_byte, end:chunk_byte+1, stream:writeStream});
		}else if(current.end === chunk_byte){
			current.end = chunk_byte+1;
		}else{
			throw new Error;
		}
	}

	function release(){
		// Iterate through the bytes, merge adjacent bytes from the same chunk together
		// Write through only the parts of chunks that were known
		body_chunks_maybe.forEach(function(chunkData){
			// Merge the maybe chunks into the definitely chunks
			if(current.end === chunkData.start){
				current.end = chunkData.end;
			}else{
				body_chunks.push(chunkData);
			}
		});
		body_chunks_maybe = [];
	}

	if(fp) fp.close();
	if(writeStream) writeStream.close();
	// await new Promise(function(resolve, reject){ writeStream.once('close', resolve); writeStream.once('error', reject); });
	return;
}

async function handleApplicationByteranges(req){
	var fields = "";
	var state = 0;
	var int_state = null;
	var int_value = null;
	var section_length = 0;
	var field_length = 0;

	var si = 0;
	// *(*text CRLF) dash-boundary
	const s_framing_indicator = si++;
	const s_known_length_field_length = si++;
	const s_known_length_field_name_length = si++;
	const s_known_length_field_name_value = si++;
	const s_known_length_field_value_length = si++;
	const s_known_length_field_value_value = si++;
	const s_known_length_field_line = si++;
	const s_known_length_content_length = si++;
	const s_known_length_content_value = si++;
	const s_indeterminate_length_field_line = si++;
	const s_indeterminate_length_field_name_length = si++;
	const s_indeterminate_length_field_value_length = si++;
	const s_void = si++;
	const s_names = ['s_framing_indicator','s_known_length_field_length','s_known_length_field_name_length','s_known_length_field_name_value','s_known_length_field_value_length','s_known_length_field_value_value','s_known_length_field_line','s_known_length_content_length','s_known_length_content_value','s_indeterminate_length_field_line','s_indeterminate_length_field_name_length','s_indeterminate_length_field_value_length','s_void'];
	var boundary_s = '';
	var boundary = [];
	var body_chunks = [];
	var body_chunks_maybe = [];
	function parse_int(c){
		if(typeof c !== 'number') throw new Error;
		if(int_state === null){
			if(c >= 0x80){
				throw new Error;
			}else if(c >= 0x40){
				int_state = (1<<(c>>6)) - 1;
				int_value = c & 0b00111111;
				return null;
			}else{
				return c;
			}
		}
		int_value = (int_value<<8) + c;
		if(int_state > 0){
			int_state--;
			return null;
		}
		const val = int_value;
		int_state = null;
		int_value = null;
		return val;
	}
	for await (const chunk of req) {
		for(var chunk_byte=0; chunk_byte<chunk.length; chunk_byte++){
			const c = chunk[chunk_byte];
			// console.log(s_names[state], c.toString(16), c<0x20 ? String.fromCharCode(0x2400+c) : String.fromCharCode(c), int_state);
			switch(state){
				case s_framing_indicator:
					if(c===8){
						state = s_known_length_field_length;
					}else if(c===10){
						state = s_indeterminate_length_field_line;
						throw new Error('Indeterminate messages unsupported');
					}else throw new Error('Expected Framing Indicator');
					break;
				case s_known_length_field_length:
					section_length = parse_int(c);
					if(section_length === null) break;
					state = s_known_length_field_name_length;
					break;
				case s_known_length_field_name_length:
					section_length--;
					field_length = parse_int(c);
					if(field_length === null) continue;
					if(field_length > section_length) throw new Error('Field overruns section'+field_length+' '+section_length);
					state = s_known_length_field_name_value;
					break;
				case s_known_length_field_name_value:
					section_length--;
					field_length--;
					if(field_length === 0) state = s_known_length_field_value_length;
					break;
				case s_known_length_field_value_length:
					field_length = parse_int(c);
					section_length--;
					if(field_length === null) continue;
					if(field_length > section_length) throw new Error('Field overruns section'+field_length+' '+section_length);
					state = s_known_length_field_value_value;
					break;
				case s_known_length_field_value_value:
					section_length--;
					field_length--;
					if(section_length === 0) state = s_known_length_content_length;
					else if(field_length === 0) state = s_known_length_field_name_length;
					break;
				case s_known_length_content_length:
					section_length = parse_int(c);
					if(section_length === null) continue;
					state = s_known_length_content_value;
					break;
				case s_known_length_content_value:
					section_length--;
					if(section_length === 0) state = s_void;
					break;
				case s_indeterminate_length_field_line:
					throw new Error('Indeterminate messages unsupported');
					break;
				case s_void:
					break;
			}
		}
	}

}

function applyPart(offset, length, stream){

}

