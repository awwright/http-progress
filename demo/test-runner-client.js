
const request = require('./client-lib').request;
const http = require('http');
var entryUri = process.argv[2] || 'http://localhost:18080';

function pipe(stream){
	var req = http.request(entryUri+'/test/data');
	req.end();
	req.once('response', function(res){
		stream.setHeader('Content-length', res.headers['content-length']);
		stream.flushHeaders();
		res.pipe(stream);
	})
}

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

function runTest(id){
	console.log('Run test '+id);
	const req = request(entryUri+'/test/'+id, {
		method: 'POST',
		headers: {},
	});
	pipe(req);

	printRequest(req.initialRequest);
	req.on('initialResponse', printResponse);

	req.on('retryRequest', function(req){
		printRequest(req);
		req.on('response', printResponse);
	});

	req.on('information', function(info){
		printResponse(info);
	});

	return new Promise(function(resolve, reject){
		req.once('response', function(res){
			res.resume();
			res.on('end', resolve);
			res.on('error', reject);
		});
	});
}

async function runAll(){
	for(var i=0; i<2; i++) await runTest(i);
}

runAll();
