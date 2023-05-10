
const request = require('./client-lib').request;
const fs = require('fs');

var filepath = process.argv[2] || 'rfc8446.txt';
var fileStat = fs.statSync(filepath);
var file = fs.createReadStream(filepath);

function printRequest(req){
	console.error('> '+req.method+' '+req.path+' HTTP/1.1');
	var headers = req.getHeaders();
	for(var k in headers){
		if(typeof headers[k]==='string') console.error('> '+k+': '+headers[k]);
		else if(Array.isArray(headers[k])) headers[k].forEach(function(v){
			console.error('> '+k+': '+v);
		});
	}
	console.error('> ');
}

function printResponse(res){
	console.error('< HTTP/'+res.httpVersion+' '+res.statusCode+' '+res.statusMessage);
	for(var i=0; i<res.rawHeaders.length; i+=2){
		console.error('< '+res.rawHeaders[i]+': '+res.rawHeaders[i+1]);
	}
	console.error('< ');
}

const req = request('http://localhost:18080/print', {
	method: 'POST',
	host: 'localhost',
	port: 18080,
	path: '/print',
	headers: {
		'Content-Length': fileStat.size,
	},
});
file.pipe(req);
req.flushHeaders();

printRequest(req.initialRequest);
req.on('response', printResponse);

req.on('retryRequest', function(req){ 
	printRequest(req);
	req.on('response', printResponse);
});

req.on('information', function(info){ 
	printResponse(info);
});

req.on('end', function(){
	console.log('Done');
});
