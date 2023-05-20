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
	throw new Error('TODO');
	var fields, content, contentOffset, contentLength;
	return [fields, content, contentOffset, contentLength];
}

async function handleApplicationByteranges(req){
	throw new Error('TODO');
	var fields, content, contentOffset, contentLength;
	return [fields, content, contentOffset, contentLength];
}

function applyPart(offset, length, stream){

}

