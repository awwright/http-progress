
var inherits = require('util').inherits;
// var OutgoingMessage = require('http').OutgoingMessage;
var NativeClientRequest = require('http').ClientRequest;
var EventEmitter = require('events').EventEmitter;
var uriResolve = require('url').resolve;

module.exports.request = function request(url, options, cb) {
	return new ResumableClientRequest(url, options, cb);
};

// inherits(ResumableClientRequest, OutgoingMessage);
inherits(ResumableClientRequest, EventEmitter);
function ResumableClientRequest(url, options, cb){
	var self = this;
	if(typeof url!=='string') throw new Error('`url` must be of type string');
	// OutgoingMessage.call(this);
	EventEmitter.call(this);
	this.url = url;
	this.options = options;
	this.cb = cb;
	this.initialRequest = new NativeClientRequest(url, options);
	this.initialResponse = null;
	this.currentRequest = this.initialRequest;
	this.writeDest = null;
	this.initialRequest.setHeader('Prefer', 'resume');
	this.retryUpload = [];
	this.retryDownload = [];
	this.uploadLength = 0;
	this.uploadConfirmed = 0;
	this.uploadBufferParts = [];
	this.uploadBufferOffset = 0;
	this.uploadBufferLength = 0;

	this.initialRequest.on('response', function(res){
		self.initialResponse = res;
		self.emit('response', res);
		self.emit('initialResponse', res);
		res.on('end', function(){
			self.emit('end');
		})
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
	var timeoutId = setTimeout(beginUpload, 1000);
	function beginUpload(info){
		if(timeoutId!==null){
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		if(self.initialRequestUploadStarted) return;
		self.initialRequestUploadStarted = true;
		if(info.headers){
			if(typeof info.headers['request-content-location']==='string'){
				self.initialRequestContentLocation = uriResolve(self.url, info.headers['request-content-location']);
			}
			if(typeof info.headers['response-message-location']==='string'){
				self.initialResponseMessageLocation = uriResolve(self.url, info.headers['response-message-location']);
			}
		}
		self._uploadBuffer(0);
	}

	this.initialRequest.on('error', function(err){ 
		if(self.initialResponse===false){
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

ResumableClientRequest.prototype._retryUpload = function(){
	var self = this;

	// synchronize state
	var options = {
		method: 'HEAD',
		// whitelist some known headers, maybe switch to blacklist later
		headers: {
		},
	};
	var headRequest = new NativeClientRequest(this.initialRequestContentLocation, options, headResponse);
	self.emit('retryRequest', headRequest);
	headRequest.end();
	function headResponse(headRes){
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
			if(err){
				// If successful, continue with another _submitUpload until fully uploaded
				self._retryUpload();
			}else{
				// If error, re-sync and retry
				self._submitUpload();
			}
		});
	}
};

ResumableClientRequest.prototype._submitUpload = function(offset, cb){
	// Upload new segment
	var options = {
		method: 'PATCH',
		headers: {
			'Content-Type': 'message/byteranges',
		},
	};
	var patchRequest = new NativeClientRequest(self.initialRequestContentLocation, options, patchResponse);
	self.currentRequest = patchRequest;
	self.emit('retryRequest', self.currentRequest);
	self.retryUpload.push(self.currentRequest);
	patchRequest.write('Content-Length: \r\n');
	patchRequest.write('Content-Range: \r\n');
	patchRequest.write('\r\n');
	self._uploadBuffer(offset);
	function patchResponse(res){
		res.on('error', function(err){
			cb(err);
		});
		res.on('end', function(){
			cb();
		});
	}
}


ResumableClientRequest.prototype._uploadBuffer = function(offsetBytes, cb){
	var parts = this.uploadBufferParts.length;
	this.writeDest = this.currentRequest;
	this.emit('drain');

	for(var ii=0, ib=this.uploadBufferOffset; ii<parts && ib+this.uploadBufferParts[ii].length<offsetBytes.length; ii++, ib+=this.uploadBufferParts[ii].length);
	if(ii >= parts) return;
	this.currentRequest.write(this.uploadBufferParts[ii].slice(offsetBytes-ib));
	for(ii++; ii<parts; ii++){
		this.currentRequest.write(this.uploadBufferParts[ii]);
	}
}

ResumableClientRequest.prototype._retryDownload = function(){
	var options = {
		headers: {
			'Range': '-/',
		}
	};
	this.currentRequest = new NativeClientRequest(this.url, options, retryDownloadResponse);
	self.emit('retryRequest', self.currentRequest);
	this.retryDownload.push(this.currentRequest);
	this.currentRequest.end();
	function retryDownloadResponse(res){

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

ResumableClientRequest.prototype.write = function(data){
	var self = this;
	this.uploadBufferParts.push(data);
	if(this.writeDest){
		var writable = this.writeDest.write.apply(this.writeDest, arguments);
		if(writable===false){
			this.writeDest.once('drain', function(){
				self.emit('drain');
			});
		}
		return writable;
	}
	return false;
};

ResumableClientRequest.prototype.end = function(data){
	if(data) this.write(data);
	if(this.writeDest===this.initialRequest) this.writeDest.end();
};

ResumableClientRequest.prototype.abort = function(){
	return this.initialRequest.abort.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.destroy = function(){
	return this.initialRequest.destroy.apply(this.initialRequest, arguments);
};

ResumableClientRequest.prototype.getHeader = function(){
	return this.initialRequest.getHeader.apply(this.initialRequest, arguments);
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

