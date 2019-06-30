
var inherits = require('util').inherits;
var IncomingMessage = require('http').IncomingMessage;
var NativeClientRequest = require('http').ClientRequest;
var Writable = require('stream').Writable;
var uriResolve = require('url').resolve;

module.exports.request = function request(url, options, cb) {
	return new ResumableClientRequest(url, options, cb);
};

// inherits(ResumableClientRequest, OutgoingMessage);
inherits(ResumableClientRequest, Writable);
function ResumableClientRequest(url, options, cb){
	var self = this;
	if(typeof url!=='string') throw new Error('`url` must be of type string');
	// OutgoingMessage.call(this);
	Writable.call(this);
	this.url = url;
	this.options = options;
	this.cb = cb;
	this.initialRequest = new NativeClientRequest(url, options);
	this.initialResponse = null;
	this.response = null;
	this.currentRequest = this.initialRequest;
	this.writeDest = null;
	this.writeDestAvailable = null;
	this.initialRequest.setHeader('Prefer', 'resume');
	this.initialRequest.setHeader('Expect', '100-continue');
	this.retryUpload = [];
	this.retryDownload = [];
	this.uploadLength = 0;
	this.uploadConfirmed = 0;
	this.uploadBufferParts = [];
	this.uploadBufferOffset = 0;
	this.uploadBufferLength = 0;
	this.uploadOpen = true;
	this.downloadMessageRead = 0; // Bytes successfully read from download message
	this.downloadContentRead = 0; // Bytes successfully read from download message-body
	this.method = options.method;
	this.path = options.path;

	this.initialRequest.on('response', function(res){
		self.initialResponse = res;
		const readableSide = self.response = new IncomingMessage(res);
		readableSide.httpVersion = res.httpVersion;
		readableSide.httpVersionMinor = res.httpVersionMinor;
		readableSide.httpVersionMajor = res.httpVersionMajor;
		readableSide.headers = res.headers;
		readableSide.rawHeaders = res.rawHeaders;
		var error = null;
		self.emit('response', readableSide);
		self.emit('initialResponse', res);
		res.on('data', function(chunk){
			readableSide.push(chunk);
		});
		res.on('error', function(err){
			error = err;
		});
		res.on('end', function(){
			readableSide.emit('end');
			if(!error) readableSide.push(null);
		});
	});

	if (cb) {
		this.once('response', cb);
	}
	
	this.initialRequest.on('information', function(info){ 
		self.emit('information', info);
		if(info.statusCode===100){
			beginUpload(info);
		}
	});
	var timeoutId = null;
	// var timeoutId = setTimeout(beginUpload, 1000);
	function beginUpload(info){
		if(timeoutId!==null){
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		if(self.initialRequestUploadStarted) return;
		self.initialRequestUploadStarted = true;
		if(info && info.headers){
			if(typeof info.headers['request-content-location']==='string'){
				self.initialRequestContentLocation = uriResolve(self.url, info.headers['request-content-location']);
			}
			if(typeof info.headers['response-message-location']==='string'){
				self.initialResponseMessageLocation = uriResolve(self.url, info.headers['response-message-location']);
			}
		}
		self._pipeBuffer(0, function(){});
	}

	this.initialRequest.on('error', function(err){ 
		if(self.initialResponse===null){
			if(self.initialRequestContentLocation){
				self._retryUpload();
			}else{
				self.emit('error', err);
			}
		}else{
			self.emit('error', err);
		}
	});

};

// ResumableClientRequest.prototype._implicitHeader = NativeClientRequest.prototype._implicitHeader;

ResumableClientRequest.prototype._retryUpload = function _retryUpload(){
	var self = this;

	// synchronize state
	var options = {
		method: 'HEAD',
		// whitelist some known headers, maybe switch to blacklist later
		headers: {
		},
	};
	var headRequest = new NativeClientRequest(this.initialRequestContentLocation, options);
	self.emit('retryRequest', headRequest);
	headRequest.end();
	headRequest.once('error', function(){
	});
	headRequest.once('response', function headResponse(headRes){
		if(!headRes.headers['content-length']){
			// TODO: begin re-uploading from last ACK'd byte in small segments
			return;
		}
		var ackBytes = parseInt(headRes.headers['content-length']);
		if(!(ackBytes >= 0)){
			// negative or NaN
			throw new Error('Unknown Content-Length in response');
		}
		self._submitUpload(ackBytes, function(err){
			process.nextTick(function(){
				if(err){
					// Retry if error
					self.writeDest = null;
					self._retryUpload(_retryUpload.bind(self));
					return;
				}else if(self.uploadConfirmed === self.uploadLength){
					// If all uploaded, now try downloading
					self._restartDownload();
				}else{
					// If not fully uploaded, upload next segment
					self._submitUpload(self.uploadConfirmed);
				}
			});
		});
	});
};

ResumableClientRequest.prototype._submitUpload = function(offset, cb){
	if(typeof offset!=='number') throw new Error('Expected number `offset`');
	var self = this;
	// Upload new segment
	var patchInfo =
		`Content-Range: ${offset}-${self.uploadLength-1}/${self.uploadLength}\r\n` +
		`Content-Length: ${self.uploadLength-offset}\r\n` +
		`\r\n`;
	var options = {
		method: 'PATCH',
		headers: {
			'Content-Type': 'message/byteranges',
			// comment in headers, for debugging requests without parsing message body
			'REM-patch-range': `${offset}-${self.uploadLength-1}/${self.uploadLength}`,
			'REM-patch-length': `${self.uploadLength-offset}`,
			'Content-Length': (patchInfo.length + self.uploadLength-offset).toString(),
		},
	};
	var patchRequest = new NativeClientRequest(self.initialRequestContentLocation, options);
	self.currentRequest = patchRequest;
	self.emit('retryRequest', patchRequest);
	self.retryUpload.push(patchRequest);
	patchRequest.write(patchInfo);
	self._pipeBuffer(offset, function(){
		if(!self.uploadOpen){
			self.writeDest.end();
			self.writeDest = null;
		}
	});
	patchRequest.on('error', function(err){
		if(cb) cb(err);
	});
	patchRequest.on('response', function patchResponse(res){
		if(res.statusCode >= 200 && res.statusCode <= 299){
			self.uploadConfirmed = self.uploadLength;
			res.on('end', function(){
				if(cb) cb();
			});
		}else{
			cb(new Error('Unexpected error during _submitUpload'));
		}
	});
}


ResumableClientRequest.prototype._pipeBuffer = function(offsetBytes, cb){
	var parts = this.uploadBufferParts.length;

	for(var ii=0, ib=this.uploadBufferOffset; ii<parts && ib+this.uploadBufferParts[ii].length<offsetBytes; ib+=this.uploadBufferParts[ii].length, ii++);
	if(ii >= parts) return;
	this.currentRequest.write(this.uploadBufferParts[ii].slice(offsetBytes-ib));
	for(ii++; ii<parts; ii++){
		this.currentRequest.write(this.uploadBufferParts[ii]);
	}

	this.writeDest = this.currentRequest;
	if(this.writeDestAvailable) this.writeDestAvailable();
	this.writeDestAvailable = null;
	cb();
}

ResumableClientRequest.prototype._restartDownload = function(){
	var self = this;

	// synchronize state
	var options = {
		method: 'GET',
		// whitelist some known headers, maybe switch to blacklist later
		headers: {
		},
	};
	var req = new NativeClientRequest(this.initialResponseMessageLocation, options);
	self.emit('retryRequest', req);
	req.end();
	// req.once('error', function(){});
	req.once('response', function(res){
		if(!res.headers['content-type'] || res.headers['content-type']!=='message/http'){
			self.emit('error', new Error('Unknown media type for Response-Message-Location'));
			return;
		}
		var buffer = new Uint8Array(0);
		var state = 'status-line';
		var httpVersionMajor, httpVersionMinor, statusCode, statusMessage;
		var messageHeaders = {};
		var rawHeaders = [];
		var readableSide;
		res.on('data', function(data){
			self.downloadMessageRead += data.length;
			buffer = Buffer.concat([buffer, data]);
			while(buffer.length){
				if(state==='status-line'){
					var crlf = buffer.indexOf("\r\n");
					if(crlf<0 && buffer.length>1000) throw new Error('Status-line too long');
					var line = buffer.slice(0, crlf).toString().match(/^HTTP\/(\d)\.(\d) (\d{3}) ([A-Za-z-]+)$/);
					httpVersionMajor = line[1];
					httpVersionMinor = line[2];
					statusCode = line[3];
					statusMessage = line[4];
					buffer = buffer.slice(crlf + 2);
					state = 'header-line';
				}else if(state==='header-line'){
					var crlf = buffer.indexOf("\r\n");
					if(crlf===0){
						// Blank line, end of headers
						state = 'message-body';
						haveHeaders();
						buffer = buffer.slice(2);
						continue;
					}
					var line = buffer.slice(0, crlf).toString().match(/^([A-Za-z-]+): (.*)$/);
					var headerName = line[1];
					var headerValue = line[2];
					messageHeaders[headerName.toLowerCase()] = headerValue;
					rawHeaders.push(headerName);
					rawHeaders.push(headerValue);
					buffer = buffer.slice(crlf + 2);
				}else if(state==='message-body'){
					readableSide.push(buffer);
					self.downloadContentRead += buffer.length;
					buffer = Buffer.alloc(0);
					return;
				}else{
					throw new Error('Unknown state');
				}
			}
		});
		function haveHeaders(){
			readableSide = self.response = new IncomingMessage(res);
			readableSide.httpVersion = httpVersionMajor + '.' + httpVersionMinor;
			readableSide.httpVersionMajor = parseInt(httpVersionMajor);
			readableSide.httpVersionMinor = parseInt(httpVersionMinor);
			readableSide.statusCode = statusCode;
			readableSide.statusMessage = statusMessage;
			readableSide.headers = messageHeaders;
			readableSide.rawHeaders = rawHeaders;
			self.emit('response', readableSide);
		}
		res.on('end', function(){
			self.response.push(null);
		});
	});
}

ResumableClientRequest.prototype._retryDownload = function(){
	var self = this;
	var options = {
		headers: {
			'Range': '-/',
		}
	};
	var downloadReq = new NativeClientRequest(this.url, options, retryDownloadResponse);
	self.emit('retryRequest', downloadReq);
	this.retryDownload.push(downloadReq);
	downloadReq.end();
	function retryDownloadResponse(res){
		self.emit('retryResponse', res);
		res.on('data', function(chunk){
			self.response.push(chunk);
		});
		res.on('end', function(){
			self.response.push(null);
		});
	}
};

/*
NativeClientRequest events:
abort
connect
continue
information
response
socket
timeout
upgrade

ResumableClientRequest events:
clientRequest
*/

ResumableClientRequest.prototype.flushHeaders = function(){
	this.uploadLength = parseInt(this.initialRequest.getHeader('Content-Length'));
	return this.initialRequest.flushHeaders.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype._write = function(data, encoding, callback){
	var self = this;
	if(data){
		this.uploadBufferParts.push(data);
		this.uploadBufferLength += data.length;
	}
	// console.log('client buffer '+this.uploadBufferLength);
	this.writeDestAvailable = callback;
	if(this.writeDest){
		return this.writeDest.write(data, encoding, function(){
			self.writeDestAvailable = null;
			callback();
		});
	}
};

ResumableClientRequest.prototype._final = function _final(callback){
	if(this.writeDest) this.writeDest.end();
	this.writeDest = null;
	this.uploadOpen = false;
}

ResumableClientRequest.prototype.abort = function(){
	return this.initialRequest.abort.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.destroy = function(){
	return this.initialRequest.destroy.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.getHeader = function(){
	return this.initialRequest.getHeader.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.getHeaders = function(){
	return this.initialRequest.getHeaders.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.removeHeader = function(){	
	return this.initialRequest.removeHeader.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.setHeader = function(){
	return this.initialRequest.setHeader.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.setNoDelay = function(){
	return this.initialRequest.setNoDelay.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.setSocketKeepAlive = function(){
	return this.initialRequest.setSocketKeepAlive.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.setTimeout = function(){
	return this.initialRequest.setTimeout.apply(this.initialRequest, arguments);
};

