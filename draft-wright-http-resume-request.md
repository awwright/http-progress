# Partial and Resumable Requests in HTTP

This document describes a standard mechanism by which servers can address the location where a request is being processed, allowing subsequent requests to complete it, if interrupted.


## Introduction

HTTP is a stateless protocol, which implies that if a request is interrupted, there can be no way to resume it. This is not normally an issue if there is an alternate way of arriving to the desired state from an incomplete state transition. For example if a download is interrupted, the user-agent may request just the missing parts in a Range request. However, if an unsafe request is interrupted before the client receives the response, there is no standard way of determining the result of that operation; the user agent is forced to read the state of the server before deciding on a course of action, which is often implementation-specific. This document standardizes a way of re-requesting the result of an operation. 


 ## Continue Outstanding Request Workflow

When a user-agent wants to be able to make a request on a resource, and upload the request body in segments, the server must create a resource that the user agent can upload to. Once the resource has been written to, it can use the contents of that resource as the request-body for the original request.

The initial request is done with `Expect: 100-continue` with `Prefer: resume`, which will return a `100 Continue` intermediate response with `Request-Content-Location`, `Response-Message-Location`, and/or `Content-Location` headers.

If the bootstrap was interrupted, the client can be assured the server state has not changed because the server state cannot change until the `100 Continue` response begins uploading.

If the request is interrupted, the request resource may be queried to determine if the server received the full contents. If not, the upload may be completed by issuing a PATCH request to complete the contents.

If the upload was received by the server but the response was not received by the client, the client may query the response message resource to determine if a response is available.

If the response headers were received, but the payload was only partially received, the client may make a Range request to the content-location resource to complete the download of the response.


## Registrations

### Request-Content-Location

This response header specifies the server-specified location that the request message-body will be available at.

This may be used in a 1xx status to indicate where the client may continue uploading a body to, in the event the upload is interrupted.


### Response-Message-Location

This response header specifies the server-specified location where a copy of the final response will be made available at. This document SHOULD be `message/http` (regardless of protocol, including HTTP/2), and MAY include the response body.

This header is used by clients to determine the final result of a request that has been interrupted.


### "incomplete" preference

The `incomplete` HTTP Preference specifies how a server should respond to a resource that has not been fully written out.

* `incomplete=stream` indicates the server should hold the connection open, waiting for the bytes to become available.
* `incomplete=status` indicates the server should send a 2__ (Incomplete Content) response code indicating the server expects more content for the resource in the near future.


### "resumable" preference

The `incomplete` HTTP Preference specifies how a server should handle a request that was terminated before it was finished by the client.

* `resumable=save-incomplete` indicates the server should commi
* `resumable=ignore` indicates the server discard the operation


## Security Conscerns

