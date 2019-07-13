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
var stream = require('stream');
var port = process.env.PORT || 18080;

// Status code to use for 2__ (Incomplete Resource)
// For testing, overload an existing one that we don't need, but can't be registered
var IncompleteResource = 299; 

var requests = new Map;
var requestCount = 0;

// List of flags to apply to each request
var testSuite = [
	{},
	{interruptInitialUpload: true},
	{interruptInitialUpload: true, interruptPatchUpload: true},
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

function ResumableJob(reqId){
	this.reqId = reqId; // Used to generate link relations to this resource
	this.jobReqRead = 0; // How many bytes have been read for current job
	this.jobReqLength = null; // How many bytes are expected for current job
	this.initialRequest = null; // The request object that kicked off this job
	this.initialResponse = null; // The response object to the initial request
	this.currentRequest = null; // Current client allowed to upload to this job
	this.currentResponse = null; // initialResponse, if known to be active
	this.req = null; // Readable object representing initial request plus any data appended in subsequent requests
	this.res = null; // Writable object that buffers data, and forwards to initial response (if still active)
	this.clientStart = 0; // What byte the current client wil upload through
	this.resPayload = Buffer.alloc(0); // Buffered response, so it may be re-requested
	this.resPayloadFinal = false; // If final response is fully written
	// Flags to change behavior
	this.flags = {};
}

ResumableJob.prototype.initRequest = function initRequest(req, res, initializeJob){
	var self = this;

	if(this.initialRequest !== null || this.initialRequest !== null) throw new Error('Init after resume');
	self.initialRequest = req;
	self.initialResponse = res;
	self.currentRequest = req;
	self.currentResponse = res;

	// A Content-Length is required to allocate the correct amount of memory
	if(!req.headers['content-length'] || !req.headers['content-length'].match(/^\d+$/)){
		res.statusCode = 411;
		res.end();
		return;
	}
	this.jobReqRead = 0;
	this.jobReqLength = parseInt(req.headers['content-length']);
	if(req.headers['expect'] && req.headers['expect'] !== '100-continue'){
		res.statusCode = 417;
		res.end();
	}
	if(req.headers['expect'] !== '100-continue'){
		res.statusCode = 400;
		res.setHeader('Content-Type', 'text/plain');
		res.end('Expected 100-continue\r\n');
	}
	if(this.flags.interruptContinue && !this.interruptContinueTrip){
		this.interruptContinueTrip = true;
		// console.error('Destroying client connection');
		res.socket.destroy();
	}
	// TODO fully parse this header
	if(req.headers['prefer']){
		res._writeRaw('HTTP/1.1 100 Continue\r\n');
		res._writeRaw(`Request-Content-Location: /job/${this.reqId}.req\r\n`);
		res._writeRaw(`Response-Message-Location: /job/${this.reqId}.res\r\n`);
		res._writeRaw(`\r\n`);
	}

	self.req = new httplib.IncomingMessage(this);
	self.req.method = req.method;
	self.req.httpVersion = req.httpVersion;	
	self.req.rawHeaders = req.rawHeaders;
	self.req.headers = req.headers;
	var read = 0;
	req.on('data', function(segment){
		read += segment.length;
		if(self.flags.interruptInitialUpload && read > 100000){
			// Interrupt the connection after reading a certain amount of bytes
			// console.error('Destroying client connection');
			res.socket.destroy();
		}
		
		const ret = self.req.push(segment);
		if (ret === false) {
			if (((state.pipesCount === 1 && state.pipes === dest) || (state.pipesCount > 1 && state.pipes.includes(dest))) && !cleanedUp) {
				state.awaitDrain++;
			}
			src.pause();
		}
	});
	req.on('drain', function(){
	});
	req.on('end', function(){
		if(req.trailers) self.req.trailers = req.trailers;
		if(req.rawTrailers) self.req.rawTrailers = req.rawTrailers;
		res._writeRaw(`HTTP/1.1 102 Processing\r\n`);
		res._writeRaw(`\r\n`);
	});

	// Buffer data written to response and also write it to original response, if available
	self.res = new stream.Writable();
	Object.defineProperty(self.res, 'statusCode', {
		set: function(v){ self.initialResponse.statusCode = v; },
		get: function(){ return self.initialResponse.statusCode; },
	});
	Object.defineProperty(self.res, 'statusMessage', {
		set: function(v){ self.initialResponse.statusMessage = v; },
		get: function(){ return self.initialResponse.statusMessage; },
	});
	self.res.setHeader = function setHeader(name, value){
		self.initialResponse.setHeader(name, value);
	}
	self.res.getHeaders = function getHeaders(){
		self.initialResponse.getHeaders();
	}
	self.res.write = function(data){
		if(data && self.resPayload){
			self.resPayload = Buffer.concat([self.resPayload, Buffer.from(data)]);
		}
		if(self.currentResponse){
			self.currentResponse.write(data, encoding);
		}
	}
	self.res.end = function(data){
		if(data && self.resPayload){
			self.resPayload = Buffer.concat([self.resPayload, Buffer.from(data)]);
		}
		if(self.currentResponse){
			self.currentResponse.end(data);
		}
		self.currentResponse = null;
	}
	initializeJob(self.req, self.res);
};

ResumableJob.prototype.resumeRequest = function resumeRequest(req, res){
	res.setHeader('Allow', 'GET, HEAD, PATCH, DELETE');
	if(req.method==='GET' || req.method==='HEAD'){
		return this.renderRequest(req, res);
	}else if(req.method==='PATCH'){
		return this.patchRequest(req, res);
	}else if(req.method==='DELETE'){
		return this.deleteRequest(req, res);
	}else{
		res.statusCode = 405;
		if(this.jobPayload){
			res.setHeader('Allow', 'GET, HEAD, PATCH, DELETE');
		}else{
			res.setHeader('Allow', 'HEAD, PATCH, DELETE');
		}
		res.end();
		return;
	}
}

ResumableJob.prototype.confirm = function confirm(confirmedBytes){
	// Indicate bytes that have been saved and do not need to be re-transmitted by the client
	var self = this;
	if(confirmedBytes < self.jobReqRead){
		throw new Error('Already sent confirmation for bytes');
	}else if(confirmedBytes === self.jobReqRead){
		return;
	}
	self.jobReqRead = confirmedBytes;
	if(this.jobReqRead === this.jobReqLength){
		// Data is fully uploaded, respond to current request with final result
		this.req.emit('end');
		this.initialResponse.statusCode = this.res.statusCode;
		this.initialResponse.statusMessage = this.res.statusMessage;
		this.initialResponse.statusMessage = this.res.statusMessage;
		this.initialResponse.httpVersion = this.res.httpVersion;
		this.initialResponse.httpVersionMinor = this.res.httpVersionMinor;
		this.initialResponse.httpVersionMajor = this.res.httpVersionMajor;
		this.initialResponse.headers = this.res.headers;
		this.initialResponse.rawHeaders = this.res.rawHeaders;
		this.res.write = function(data){
			self.initialResponse.write(data);
		};
		this.res.end = function(data){
			self.initialResponse.end(data);
		};
		// Hool self.res
	}else if(this.jobReqRead === this.initialRequestEnd){
		// Data for current PATCH is fully uploaded, respond with 2__ Incomplete Content
		this.initialResponse.statusCode = this.res.statusCode;
		this.initialResponse.statusMessage = this.res.statusMessage;
		this.initialResponse.end();
	}else if(this.initialResponse){
		// Tell client about confirmed data
		this.initialResponse._writeRaw(`HTTP/1.1 199 Acknowledge ${self.jobReqRead}B\r\n`);
		this.initialResponse._writeRaw(`\r\n`);
	}
}

ResumableJob.prototype.renderRequest = function renderRequest(req, res){
	if(this.jobReqRead < this.jobReqLength){
		res.statusCode = IncompleteResource;
		res.statusMessage = 'Incomplete Resource'
	}else{
		res.statusCode = 200;
	}
	res.setHeader('Content-Length', this.jobReqRead);
	if(req.method==='HEAD'){
		res.end();
	}else if(this.jobPayload){
		res.end(this.jobPayload.slice(0, this.jobReqRead));
	}else{
		throw new Error('Not supported');
	}
}

ResumableJob.prototype.patchRequest = function patchRequest(req, res){
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
	var read = 0;
	req.on('data', function(data){
		if(self.flags.interruptPatchUpload && read > 100000){
			// Interrupt the connection after reading a certain amount of bytes
			// console.error('Destroying client connection');
			res.socket.destroy();
		}
		read += data.length;
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
					var contentLength = parseInt(messageHeaders['content-length']);
					segmentOffset = parseInt(m[1]);
					var segmentEnd = parseInt(m[2]);
					var segmentTotal = parseInt(m[3]);
					if(segmentOffset !== self.jobReqRead){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Incorrect Content-Range starting index: Have '+segmentOffset+', expect '+self.jobReqRead+'\r\n');
					}
					if(segmentEnd > self.jobReqLength || segmentEnd < segmentOffset){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Incorrect Content-Range ending index.\r\n');
					}
					if(segmentTotal !== self.jobReqLength){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Incorrect Content-Range total length.\r\n');
					}
					if(contentLength !== segmentEnd-segmentOffset+1){
						res.statusCode = 400;
						res.setHeader('Content-Type', 'text/plain')
						return res.end('Mismatch between Content-Length and Content-Range.\r\n');
					}
					requestRemaining = parseInt(messageHeaders['content-length']);

					self.initialRequest = req;
					self.initialResponse = res;
					buffer = buffer.slice(2);
					continue;
				}
				var line = buffer.slice(0, crlf).toString().match(/^([A-Za-z-]+): (.*)$/);
				var headerName = line[1];
				var headerValue = line[2];
				messageHeaders[headerName.toLowerCase()] = headerValue;
				buffer = buffer.slice(crlf + 2);
			}else if(state==='message-body'){
				if(self.initialRequest !== req){
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/plain');
					return res.end('Upload interrupted by another session.\r\n');
				}
				if(buffer.length > requestRemaining){
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/plain');
					return res.end('Patch longer than declared length.\r\n');
				}
				if(segmentOffset + buffer.length > self.jobReqLength){
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/plain')
					return res.end('Over-long patch body.\r\n'+`${segmentOffset} + ${buffer.length} > ${self.jobReqLength}\r\n`);
				}
				if(self.jobPayload){
					buffer.copy(self.jobPayload, segmentOffset);
				}else{
					self.req.push(buffer);
				}
				segmentOffset += buffer.length;
				requestRemaining -= buffer.length;
				buffer = Buffer.alloc(0);
				return;
			}else{
				throw new Error('Unknown state');
			}
		}
	});
	req.on('end', function(){
		if(requestRemaining){
			res.statusCode = 400;
			res.setHeader('Content-Type', 'text/plain')
			return res.end('Under-size patch body.\r\n');
		}
		if(self.jobReqLength === self.jobReqRead){
			// self.executeJob(self.req, self.res);
			self.res.end();
		}else{
			res.statusCode = IncompleteResource;
			res.statusMessage = 'Incomplete Resource';
			res.setHeader('Content-Type', 'text/plain');
			res.end(`${self.jobReqRead}/${self.jobReqLength} bytes\r\n`);
			return;
		}
	});
}

ResumableJob.prototype.initializeJob = function initializeJob(req, res){
	// Determine if uploaded size equals expected
	res.setHeader('Content-Type', 'text/plain');
	res.end("Job received\r\n");
	req.resume();
}

ResumableJob.prototype.renderResponseMessage = function renderResponseMessage(req, res){
	// Output the current status of the request
	res.setHeader('Content-Type', 'message/http');
	res.write('HTTP/1.1 '+this.res.statusCode+' '+this.res.statusMessage+'\r\n');
	res.write('MIME-Version: 1.0\r\n');
	var headers = this.res.getHeaders();
	for(var k in headers){
		if(typeof headers[k]==='string') res.write(k+': '+headers[k]+'\r\n');
		else if(Array.isArray(headers[k])) headers[k].forEach(function(v){
			res.write(k+': '+v+'\r\n');
		});
	}
	res.write('\r\n');
	res.end(this.resPayload);
}

ResumableJob.prototype.renderStatusDocument = function renderStatusDocument(req, res){
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
	if(m = req.url.match(/^\/job\/(\d+)\.req$/)){
		var reqId = parseInt(m[1]);
		if(!requests.has(reqId)){
			res.writeHead(404);
			res.end();
			return;
		}
		requests.get(reqId).resumeRequest(req, res);
		return;
	}
	// Resources representing the status of an ongoing job
	if(m = req.url.match(/^\/job\/(\d+)\.job$/)){
		var reqId = parseInt(m[1]);
		if(!requests.has(reqId)){
			res.writeHead(404);
			res.end();
			return;
		}
		res.setHeader('Allow', 'GET, HEAD, DELETE');
		var state = requests.get(reqId);
		if(req.method==='GET' || req.method==='HEAD'){
			return state.renderStatusDocument(req, res);
		}else if(req.method==='DELETE'){
			return state.deleteStatusDocument(req, res);
		}else{
			res.statusCode = 405;
			res.end();
			return;
		}
	}
	// Resources representing the final response for a job
	if(m = req.url.match(/^\/job\/(\d+)\.res$/)){
		var reqId = parseInt(m[1]);
		if(!requests.has(reqId)){
			res.writeHead(404);
			res.end();
			return;
		}
		res.setHeader('Allow', 'GET, HEAD, DELETE');
		var state = requests.get(reqId);
		if(req.method==='GET' || req.method==='HEAD'){
			return state.renderResponseMessage(req, res);
		}else if(req.method==='DELETE'){
			return state.deleteResponseMessage(req, res);
		}else{
			res.statusCode = 405;
			res.end();
			return;
		}
	}
	// New job requests
	if(req.url === '/print'){
		res.setHeader('Allow', 'GET, HEAD, POST');
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'text/plain');
			if(req.method==='HEAD') return void res.end();
			res.end("It's a resource\r\n");
			return;
		}else if(req.method==='POST'){
			var reqId = requestCount++;
			var state = new ResumableJob(reqId);
			requests.set(reqId, state);
			state.initRequest(req, res, function(ereq, eres){
				eres.statusCode = 500;
				eres.setHeader('Content-Type', 'text/plain');
				eres.end('Feature not implemented\r\n');
			});
			return;
		}else{
			res.statusCode = 405;
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
		res.setHeader('Allow', 'GET, HEAD, POST');
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'text/plain');
			if(req.method==='HEAD') return void res.end();
			res.end("Stream /test/data to a POST request on this resource to begin test.\r\n");
			return;
		}else if(req.method==='POST'){
			var reqId = requestCount++;
			var state = new ResumableJob(reqId);
			requests.set(reqId, state);
			state.flags = testSuite[testId];
			state.initRequest(req, res, function initializeJob(ereq, eres){
				ereq.on('data', function(data){
					for(var i=0; i<data.length; i++){
						var bi = state.jobReqRead + i;
						var num = Math.floor(bi/10);
						var expected = (('0000000'+num).substr(-8) + '\r\n').charCodeAt(bi % 10);
						if(data[i] !== expected){
							testStatus[testId].status = "fail";
							testStatus[testId].message = "Test failed at byte "+i;
							// console.error("Test failed at byte "+i+"\r\n"+`Got ${String.fromCharCode(data[i])} expected ${String.fromCharCode(expected)}`);
							// console.error(data.slice(0, i+1).toString());
							// console.error(res._writableState.ending);
							eres.end(testStatus[testId].message+"\r\n");
						}
					}
					state.confirm(state.jobReqRead + data.length);
				});
				ereq.on('end', function(){
					state.confirm(state.jobReqRead);
					testStatus[testId].status = "pass";
					eres.setHeader('Content-Type', 'text/plain');
					eres.end("Finished job result!\r\n");
				});
			});
			return;
		}else{
			res.statusCode = 405;
			res.end();
			return;
		}
	}
	if(req.url === '/test/'){
		// Show all tests to run
		res.setHeader('Allow', 'GET, HEAD');
		if(req.method==='GET' || req.method==='HEAD'){
			var json = JSON.stringify(testStatus.map(function(item){
				return item.href;
			}), null, ' ') + "\n";
			res.setHeader('Content-Type', 'application/json');
			// `json` is only ASCII characters, so this works
			res.setHeader('Content-Length', json.length);
			if(req.method==='HEAD') return void res.end();
			res.end(json);
			return;
		}else{
			res.statusCode = 405;
			res.end();
			return;
		}
	}
	if(req.url === '/test/data'){
		// Generate a list of numbers, which provides very predictable output for the server to test
		res.setHeader('Allow', 'GET, HEAD');
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
			res.end();
			return;
		}
	}
	if(req.url === '/test/status'){
		res.setHeader('Allow', 'GET, HEAD, POST');
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify(testStatus,null,'\t')+"\n");
			return;
		}else if(req.method==='POST'){
			var reqId = requestCount++;
			var state = new ResumableJob(reqId, req);
			requests.set(reqId, state);
			state.initRequest(req, res);
			return;
		}else{
			res.statusCode = 405;
			res.end();
			return;
		}
	}
	if(req.url === '/test/reset'){
		res.setHeader('Allow', 'GET, HEAD, POST');
		if(req.method==='GET' || req.method==='HEAD'){
			res.setHeader('Content-Type', 'text/plain');
			if(req.method==='HEAD') return void res.end();
			res.end("Call POST to reset test suite.\r\n");
			return;
		}else if(req.method==='POST'){
			resetTestStatus();
			res.end();
			return;
		}else{
			res.statusCode = 405;
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
