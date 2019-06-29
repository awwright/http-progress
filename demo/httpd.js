"use strict";

// This is an example server that simulates receiving a print job,
// then sending it to a printer once uploaded.
// This demonstrates how canceled uploads may be resumed, and
// how the progress of accepted jobs may be tracked until completion.

// The </print> endpoint accepts POST requests with plain text documents.
// It stream parses the input document for correct line length and page separations.
// Then it spools the job to the printer, returning 102 Progress events as updates are available.

/*
TODO:
Define several POST endpoints are defined that will create various connection errors.
To function, the client needs to `GET /test/data`, then pipe the stream into `POST /test/{number}`
Once all the endpoints have been called, the client can GET /test/results and see if the tests passed.
*/

var httplib = require('http');
var port = process.env.PORT || 18080;

// Status code to use for 2__ (Incomplete Resource)
// For testing, overload an existing one that we don't need, but can't be registered
var IncompleteResource = 299; 

var requests = new Map;
var requestCount = 0;

// List of flags to apply to each request
var testSuite = [
	{interruptInitialUpload: true},
];

var testStatus = [];
function resetTestStatus(){
	testStatus = [];
	for(var i=0; i<testSuite.length; i++){
		testStatus[i] = {
			href: '/test/'+i,
			status: 'waiting', // may be "pass", "warn", "fail", "pending", "waiting"
			warn: null, // message about warning, if any
		};
	}
}
resetTestStatus();

function RequestState(reqId, req){
	this.reqId = reqId;
	this.req = req;
	this.requestPayloadRead = 0;
	this.requestPayload = null;
	// Flags to change behavior
	this.flags = {};
}

RequestState.prototype.init = function init(req, res){
	var self = this;
	// A Content-Length is required to allocate the correct amount of memory
	if(!req.headers['content-length'] || !req.headers['content-length'].match(/^\d+$/)){
		res.statusCode = 411;
		res.end();
		return;
	}
	this.requestPayloadRead = 0;
	this.requestPayload = new Buffer(parseInt(req.headers['content-length']));
	// TODO fully parse this header
	if(req.headers['prefer']){
		res._writeRaw('HTTP/1.1 100 Continue\r\n');
		res._writeRaw(`Request-Content-Location: /req/${this.reqId}.req\r\n`);
		res._writeRaw(`Response-Message-Location: /req/${this.reqId}.res\r\n`);
		res._writeRaw(`\r\n`);
	}
	req.on('data', function(segment){
		segment.copy(self.requestPayload, self.requestPayloadRead, 0, segment.length);
		self.requestPayloadRead += segment.length;
		res._writeRaw(`HTTP/1.1 199 Acknowledge ${self.requestPayloadRead}B\r\n`);
		// res._writeRaw(`Request-Ack: ${self.requestPayloadRead}\r\n`);
		res._writeRaw(`\r\n`);
		if(self.flags.interruptInitialUpload && self.requestPayloadRead > 200000){
			// Interrupt the connection after reading a certain amount of bytes
			res._writeRaw(`HTTP/1.1 199 Bye\r\n`);
			console.error('Destroying client connection');
			res.socket.destroy();
		}
	});
	req.on('end', function(segment){
		res._writeRaw(`HTTP/1.1 199 Acknowledge end\r\n`);
		res._writeRaw(`\r\n`);
		// Determine if uploaded size equals expected
	});
};

RequestState.prototype.renderRequest = function renderRequest(req, res){
	if(this.finalLength===null || this.requestPayloadRead < this.requestPayload.length){
		res.statusCode = IncompleteResource;
		res.statusMessage = 'Incomplete Resource'
	}else{
		res.statusCode = 200;
	}
	res.setHeader('Content-Length', this.requestPayloadRead);
	res.end(this.requestPayload.slice(0, this.requestPayloadRead));
}

RequestState.prototype.patchRequest = function patchRequest(req, res){
	var self = this;
	// Parse the patch
	if(!req.headers['content-type'] || req.headers['content-type']!=='message/byteranges'){
		res.statusCode = 415;
		return res.end();
	}
	var buffer = new Uint8Array(0);
	var state = 'header-line';
	var messageHeaders = {};
	var segmentOffset = null;
	var requestRemaining = null;
	req.on('data', function(data){
		buffer = Buffer.concat([buffer, data]);
		while(buffer.length){
			if(state==='header-line'){
				var crlf = buffer.indexOf("\r\n");
				if(crlf===0){
					// Blank line, end of headers
					state = 'message-body';
					if(!messageHeaders['content-length'] || !messageHeaders['content-length'].match(/^\d+$/)){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Expected patch to contain a Content-Length field.\r\n');
					}
					if(!messageHeaders['content-range'] || !messageHeaders['content-range'].match(/^(\d+)-(\d+)\/(\d+)$/)){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain');
						return res.end('Expected patch to contain a Content-Range field.\r\n');
					}
					var m = messageHeaders['content-range'].match(/^(\d+)-(\d+)\/(\d+)$/);
					segmentOffset = parseInt(m[1]);
					var segmentEnd = parseInt(m[2]);
					var segmentTotal = parseInt(m[3]);
					console.error(`PATCH ${segmentOffset}-${segmentEnd}/${segmentTotal} ${messageHeaders['content-length']}`);
					if(segmentOffset !== self.requestPayloadRead){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Incorrect Content-Range starting index: Have '+segmentOffset+', expect '+self.requestPayloadRead+'\r\n');
					}
					if(segmentEnd > self.requestPayload.length || segmentEnd < segmentOffset){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Incorrect Content-Range ending index.\r\n');
					}
					if(segmentTotal !== self.requestPayload.length){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Incorrect Content-Range total length.\r\n');
					}
					requestRemaining = parseInt(messageHeaders['content-length']);
					buffer = buffer.slice(2);
					continue;
				}
				var line = buffer.slice(0, crlf).toString().match(/^([A-Za-z-]+): (.*)$/);
				var headerName = line[1];
				var headerValue = line[2];
				messageHeaders[headerName.toLowerCase()] = headerValue;
				buffer = buffer.slice(crlf + 2);
			}else if(state==='message-body'){
				if(buffer.length > requestRemaining){
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/plain');
					return res.end('Patch longer than declared length.\r\n');
				}
				if(segmentOffset + buffer.length > self.requestPayload.length){
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/plain')
					return res.end('Over-long patch body.\r\n'+`${segmentOffset} + ${buffer.length} > ${self.requestPayload.length}\r\n`);
				}
				buffer.copy(self.requestPayload, segmentOffset);
				self.requestPayloadRead += buffer.length;
				segmentOffset += buffer.length;
				requestRemaining -= buffer.length;
				res._writeRaw(`HTTP/1.1 199 Acknowledge ${self.requestPayloadRead}B\r\n`);
				res._writeRaw(`\r\n`);
				buffer = Buffer.alloc(0);
				return;
			}
		}
	});
	req.on('end', function(){
		console.error('End');
		if(self.requestPayload.length === self.requestPayloadRead){
			res.statusCode = 202;
			res.setHeader('Location', `/req/${self.reqId}.job`);
			return res.end();
		}else{
			res.statusCode = IncompleteResource;
			res.statusMessage = 'Incomplete Resource';
			return res.end(`${self.requestPayloadRead}/${self.requestPayload.length} bytes\r\n`);
		}
	});
}

RequestState.prototype.renderResponseMessage = function renderResponseMessage(req, res){
	// Output the current status of the request
}

RequestState.prototype.renderStatusDocument = function renderStatusDocument(req, res){
	// Output the current status of the request
}

const methods = ["HEAD", "GET", "POST", "PATCH", "DELETE"];

function request(req, res){
	if(methods.indexOf(req.method)<0){
		res.statusCode = 501;
		res.end();
		return;
	}
	var m;
	// Resources representing an outstanding request
	if(m = req.url.match(/^\/req\/(\d+)\.req$/)){
		var reqId = parseInt(m[1]);
		if(!requests.has(reqId)){
			res.writeHead(404);
			res.end();
			return;
		}
		var state = requests.get(reqId);
		if(req.method==='GET' || req.method==='HEAD'){
			return state.renderRequest(req, res);
		}else if(req.method==='PATCH'){
			return state.patchRequest(req, res);
		}else if(req.method==='DELETE'){
			return state.deleteRequest(req, res);
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD, PATCH, DELETE');
			res.end();
			return;
		}
	}
	// Resources representing the status of an ongoing job
	if(m = req.url.match(/^\/req\/(\d+)\.job$/)){
		var reqId = parseInt(m[1]);
		if(!requests.has(reqId)){
			res.writeHead(404);
			res.end();
			return;
		}
		var state = requests.get(reqId);
		if(req.method==='GET' || req.method==='HEAD'){
			return state.renderStatusDocument(req, res);
		}else if(req.method==='DELETE'){
			return state.deleteStatusDocument(req, res);
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD, DELETE');
			res.end();
			return;
		}
	}
	// Resources representing the final response for a job
	if(m = req.url.match(/^\/req\/(\d+)\.res$/)){
		var reqId = parseInt(m[1]);
		if(!requests.has(reqId)){
			res.writeHead(404);
			res.end();
			return;
		}
		var state = requests.get(reqId);
		if(req.method==='GET' || req.method==='HEAD'){
			return state.renderResponseMessage(req, res);
		}else if(req.method==='DELETE'){
			return state.deleteResponseMessage(req, res);
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD, DELETE');
			res.end();
			return;
		}
	}
	// New job requests
	if(req.url === '/print'){
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'text/plain');
			if(req.method==='HEAD') return void res.end();
			res.end("It's a resource\r\n");
			return;
		}else if(req.method==='POST'){
			var reqId = requestCount++;
			var state = new RequestState(reqId, req);
			requests.set(reqId, state);
			state.init(req, res);
			return;
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD, POST');
			res.end();
			return;
		}
	}
	// Run test requests
	if(m = req.url.match(/^\/test\/(\d+)$/)){
		var testId = parseInt(m[1]);
		if(!testSuite[testId]){
			res.writeHead(404);
			res.end();
			return;
		}
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'text/plain');
			if(req.method==='HEAD') return void res.end();
			res.end("Stream /test/data to a POST request on this resource to begin test.\r\n");
			return;
		}else if(req.method==='POST'){
			var reqId = requestCount++;
			var state = new RequestState(reqId, req);
			requests.set(reqId, state);
			state.flags = testSuite[testId];
			state.init(req, res);
			return;
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD, POST');
			res.end();
			return;
		}
	}
	if(req.url === '/test/'){
		// Show all tests to run
		if(req.method==='GET' || req.method==='HEAD'){
			var json = JSON.stringify(testStatus.map(function(item){
				return item.href;
			}), null, ' ');
			res.setHeader('Content-Type', 'application/json');
			// `json` is only ASCII characters, so this works
			res.setHeader('Content-Length', json.length);
			if(req.method==='HEAD') return void res.end();
			res.end(json);
			return;
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD');
			res.end();
			return;
		}
	}
	if(req.url === '/test/data'){
		// Generate a list of numbers, which provides very predictable output for the server to test
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'text/plain');
			res.setHeader('Content-Length', '1000000');
			if(req.method==='HEAD') return void res.end();
			for(var i=0, s=''; i<100000; i++){
				res.write( ('0000000'+i).substr(-8)+'\r\n' );
			}
			res.end();
			return;
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD');
			res.end();
			return;
		}
	}
	if(req.url === '/test/status'){
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify(testStatus,null,'\t'));
			return;
		}else if(req.method==='POST'){
			var reqId = requestCount++;
			var state = new RequestState(reqId, req);
			requests.set(reqId, state);
			state.init(req, res);
			return;
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD, POST');
			res.end();
			return;
		}
	}
	if(req.url === '/test/reset'){
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'text/plain');
			if(req.method==='HEAD') return void res.end();
			res.end("Call POST to reset test suite.\r\n");
			return;
		}else if(req.method==='POST'){
			resetTestStatus();
			return;
		}else{
			res.statusCode = 405;
			res.setHeader('Allow', 'GET, HEAD, POST');
			res.end();
			return;
		}
	}

	// Other resources do not exist
	res.writeHead(404);
	res.end();
	return;
}

var server = httplib.createServer();
server.on('request', request);
server.on('checkContinue', request);
server.listen(port);
console.log('Listening on port '+server.address().port);
