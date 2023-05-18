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
			return handleGet(req, res, filepath, fp);
		}else if(req.method === 'PUT'){
			return handlePut(req, res, filepath, fp);
		}else if(req.method === 'PATCH'){
			return handlePatch(req, res, filepath, fp);
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
		return;
	}finally{
		if(fp) fp.close();
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
		console.log(read);
		read.pipe(res);
	}
}

async function handlePut(req, res, filepath, fp){
	if(req.headers['content-type'] === 'application/octet-stream'){
		// re-create the file, truncate it if it exists
		fp = await fs.open(filepath, 'w');
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

async function handlePatch(req, res, filepath, fp){
	// This is the core of the patch handling code
	var offset, body;
	if(req.headers['content-type'] === 'message/byterange'){
		var fields = Buffer.from([]);
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
		console.log(contentRange);
		offset = parseInt(contentRange[2], 10);
	}else if(req.headers['content-type'] === 'multipart/byteranges'){
		throw new Error('TODO');
	}else if(req.headers['content-type'] === 'application/byterange'){
		throw new Error('TODO');
	}else{
		res.statusCode = 415;
		res.setHeader('Content-Type', 'text/plain');
		res.end('Unsupported media type. Supported media types:\r\nmessage/byterange\r\nmultipart/byteranges\r\napplication/byterange\r\n');
		return;
	}

	// reopen the file for writing, append if exists, create if not exists
	fp = await fs.open(filepath, 'a');
	const writeStream = fp.createWriteStream({start: offset});
	writeStream.write(body);
	req.pipe(writeStream);
	res.end('\r\n');
}

