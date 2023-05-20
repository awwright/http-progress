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
		res.statusCode = 415;
		res.setHeader('Content-Type', 'text/plain');
		res.end('Unsupported media type. Supported media types:\r\nmessage/byterange\r\nmultipart/byteranges\r\napplication/byterange\r\n');
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

async function handlePatchMultipartByterange(req){
	var fields = "";
	var body = Buffer.from([]);
	var contentOffset, contentLength;
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
	const s_message_body = si++;
	const s_message_body_or_delimiter_LF = si++;
	const s_message_body_or_delimiter_dash = si++;
	const s_message_body_or_delimiter_dashdash = si++;
	const s_message_body_or_delimiter_boundary = si++;
	const s_message_body_or_delimiter_end = si++;
	const s_message_body_or_delimiter_enddash = si++;
	const s_void = si++;
	var boundary_s = '';
	var boundary = [];
	var potential_body = [];
	for await (const chunk of req) {
		for(var i=0; i<chunk.length; i++){
			const c = chunk[i];
			console.log(state, c.toString(16), c<0x20 ? String.fromCharCode(0x2400+c) : String.fromCharCode(c), boundary_state, boundary_s[boundary_state]);
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
					if(c===0x0A) state = s_message_field_start_or_CR; // LF
					else throw new Error;
					break;
				case s_message_field_start_or_CR:
					if(c>=0x20 && c<=0x7F){
						// Once we read a header, a CRLF means the start of a new header and not the end of the headers
						fields += String.fromCharCode(c);
						state = s_message_field_or_CR;
					}
					else if(c===0x0D) state = s_message_fields_CRLF; // CR
					else throw new Error;
					break;
				case s_message_field_or_CR:
					if(c>=0x20 && c<=0x7F){
						// Once we read a header, a CRLF means the start of a new header and not the end of the headers
						fields += String.fromCharCode(c);
						state = s_message_field_or_CR;
					}
					else if(c===0x0D) state = s_message_field_CRLF; // CR
					else throw new Error;
					break;
				case s_message_field_CRLF:
					if(c===0x0A) state = s_message_field_start_or_CR; // LF
					else throw new Error;
					break;
				case s_message_fields_CRLF:
					// The end of all of the headers
					if(c===0x0A){ // LF
						state = s_message_body;
						body_start = i;
					}
					else throw new Error;
					break;
				case s_message_body:
					if(c===0x0D) state = s_message_body_or_delimiter_LF; // CR
					else state = s_message_body;
					break;
				case s_message_body_or_delimiter_LF:
					if(c===0x0A) state = s_message_body_or_delimiter_dash; // "-"
					else state = s_message_body;
					break;
				case s_message_body_or_delimiter_dash:
					if(c===0x2D) state = s_message_body_or_delimiter_dashdash; // "-"
					else state = s_message_body;
					break;
				case s_message_body_or_delimiter_dashdash:
					if(c===0x2D) state = s_message_body_or_delimiter_boundary; // LF
					else state = s_message_body;
					break;
				case s_message_body_or_delimiter_boundary:
					if(c === boundary[boundary_state]){
						boundary_state++;
						if(boundary_state===boundary.length){
							state = s_message_body_or_delimiter_end;
							boundary_state = 0;
						}
					}else{
						state = s_message_body;
						boundary_state = 0;
					}
					break;
				case s_message_body_or_delimiter_end:
					if(c===0x2D) state = s_message_body_or_delimiter_enddash;
					else if(c===0x0D) state = s_0dashboundary_CRLF;
					else throw new Error;
					break;
				case s_message_body_or_delimiter_enddash:
					if(c===0x2D) state = s_void;
					else throw new Error;
					break;
				case s_void:
					break;
			}
		}
		// Try different behaviors to handle the end of the chunk depending on what state we're in
		switch(state){
			case s_message_body:
				emitChunk(chunk.slice(body_start, i));
				body_start = 0;
				break;
			case s_message_body_or_delimiter_LF:
				emitChunk(chunk.slice(body_start, i-1));
				break;
			case s_message_body_or_delimiter_dash:
				emitChunk(chunk.slice(body_start, i-2));
				break;
			case s_message_body_or_delimiter_dashdash:
				emitChunk(chunk.slice(body_start, i-3));
				break;
			case s_message_body_or_delimiter_boundary:
				emitChunk(chunk.slice(body_start, i-3-boundary_state));
				break;
			case s_message_body_or_delimiter_end:
				break;
			case s_message_body_or_delimiter_enddash:
				break;
		}
	}

	function emitChunk(){

	}
}

async function handleApplicationByteranges(req){
	throw new Error('TODO');
	var fields, content, contentOffset, contentLength;
	return [fields, content, contentOffset, contentLength];
}

function applyPart(offset, length, stream){

}

