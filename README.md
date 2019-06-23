# Resumable and Partial Operations in HTTP

This repository hosts a suite of documents that assists user agents in making large or long-running requests that manipulate the server state.

It consists of three documents:

* [Partial upload](draft-wright-http-partial-upload.md) - defines a media type and status code for uploading a portion of a request payload
* [Resumable requests](draft-wright-http-resume-request.md) - defines two headers that specify where a partially finished request is stored and may be resumed at.
* [Progress of long-running operations](draft-wright-http-progress.md) - defines serveral features that provides real-time updates of an operation being run by the server

## Use cases

It supports the following use cases:


### Segmented new file creation

Create a new document using PATCH with a `message/byteranges` media type.


### Patching a specific byte range

Use PATCH with an existing resource using the `message/byteranges` or `multipart/byteranges` media types.


### Resume interrupted request

When a request begins, the server may provide a `Request-Content-Location` representing the URI where the upload is being stored (either in memory or on disk). The request may be completed with a PATCH request to this resource.


### Reporting realtime progress of a long-running request

Allows a server to report the current status of an ongoing request using the `102 Processing` status code with a `Progress` header.


### Resume interrupted response
If a request has been fully written, but the connection is interrupted before the final response is ready, the `Response-Message-Location` header specifies a request where the final status will be available at.

If the final headers have been written but the payload transfer was interrupted, the client may additionally use the `Content-Location` header as already defined.

## Example

Here is an example of a POST request that ends up using all of the functionality described here: An initial request that is interrupted and resumed, processed by the server, with regular updates on its progress, and reading the final response:

### Request/response 1: Initial unsafe request

~~~http
POST /collection HTTP/1.1
Content-Type: application/json
Content-Length: 100
Expect: 100-continue
Prefer: resume, processing, respond-async, wait=20

~~~

The client now waits for a 100-continue response:

~~~
HTTP/1.1 100 Continue
Request-Content-Location: http://example.com/requests/1.request
Response-Message-Location: http://example.com/requests/1.response
~~~

With `100 Continue` in hand, the client begins uploading. However, somewhere along the way, the connection was lost, resulting in the server only receiving the first three bytes (a curly brace, and ␍␊ line-terminating sequence):

~~~
{
~~~

### Request/response 2: Re-synchronize upload

At this point, the client doesn't know exactly how many bytes were transferred, so it makes a HEAD request to the request-content-location:

~~~http
HEAD http://example.com/requests/1.request HTTP/1.1

~~~

The server responds:

~~~http
HTTP/1.1 2__ Incomplete Content
Content-Type: application/json
Content-Length: 3

~~~

Now the client knows only the first three bytes were received by the server. The `2__ Incomplete Content` status code tells the client the query for the resource was successful, but the server is waiting for more data to be appended to the document.

### Request/response 3: Resume upload

The client writes out a segment of the original upload using a PATCH request to the request-content-location:

~~~
PATCH http://example.com/requests/1.request HTTP/1.1
Content-Type: message/byteranges
Content-Length: {length}

Content-Type: application/json
Content-Range: bytes 3-19/100

"key": "value",
~~~

The server responds with the `2__ (Incomplete Content)` status code, indicating the upload looks good so far, but no action can be taken until the resource is fully written to.

### Request/response 3: Finish upload

The server writes out the remainder of the request using a PATCH request to the request-content-location:

~~~
PATCH http://example.com/requests/1.request HTTP/1.1
Content-Type: message/byteranges

Content-Type: application/json
Content-Range: bytes 20-99/100

"name", "..." }
~~~

Where `...` is content that has been omitted for brevity.

The server now begins processing this file, beginning by emitting a `102 Processing` intermediate response acknowledging that processing has begun. After 20 seconds of processing, the server realizes it has been running for longer than the client says it is prepared to wait, and so responds with `202 Accepted`.

~~~http
HTTP/1.1 102 Processing 
Progress: 0/3 "Herding cats"
Location: </1.status>

HTTP/1.1 102 Processing
Progress: 1/3 "Knitting sweaters"

HTTP/1.1 202 Accepted
Location: </1.status>
Content-Location: </1.status>
Content-Type: text/plain

The photographer is on step 2: Knitting sweaters
~~~

### Request/response 4: Reading the final status

Now that the client has an address to a status document, it can request that document:


~~~http
GET http://example.com/1.status HTTP/1.1
Prefer: processing, respond-async

~~~

~~~http
HTTP/1.1 102 Processing
Progress: 1/3 "Knitting sweaters"

HTTP/1.1 102 Processing
Progress: 2/3 "Slaying dragons"

HTTP/1.1 200 OK
Progress: 3/3 "Available"
Status-URI: 201 </capture>
Status-Location: </photos/42>
Content-Type: text/plain

The photographer uploaded your image to:
  <http://example.com/photos/42>
~~~


### Request/response 5: Reading the final result

If written out in the initial request, the response-message-location is the address of document that contains the response (or what would have been the response) to the initial request:

~~~http
GET http://example.com/1.response HTTP/1.1

~~~

~~~http
HTTP/1.1 201 Created
Location: http://example.com/items/1
Content-Type: text/plain
Content-Length: 19

Resource created.
~~~


