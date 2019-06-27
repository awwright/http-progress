# Partial and Resumable Requests in HTTP

This document describes a standard mechanism by which servers can address the location where a request is being processed, allowing subsequent requests to complete it, if interrupted.


## Introduction

HTTP is a stateless protocol, which implies that if a request is interrupted, there can be no way to resume it. This is not normally an issue if there is an alternate way of arriving to the desired state from an incomplete state transition. For example if a download is interrupted, the user-agent may request just the missing parts in a Range request. However, if an unsafe request is interrupted before the client receives the response, there is no standard way of determining the result of that operation; the user agent is forced to read the state of the server before deciding on a course of action, which is often implementation-specific. This document standardizes a way of re-requesting the result of an operation. 


 ## Continue Outstanding Request Workflow

When a user-agent wants to make a lengthy upload, it is typical to include `Expect: 100-continue` and wait for the server to validate the request headers before allowing the upload to proceed. In the event the request is interrupted, the server can provide a URI that addresses the location where the request is being buffered or stored.

The initial request is done with `Expect: 100-continue` with `Prefer: resume`, which will return a `100 Continue` intermediate response with `Request-Content-Location`, `Response-Message-Location`, and/or `Content-Location` headers.

If the request was interrupted before `100 Continue` was received, then the server state has not changed yet, and the client may re-issue the request.

If the request is interrupted while uploading the request payload, the request-content-resource may be queried to determine if the server received the full contents. If not, the upload may be completed by issuing a PATCH request to complete the contents.

If the upload was received by the server but the response was not received by the client, the client may query the response message resource to determine if a response is available.

If the response headers were received, but the payload was only partially received, the client may make a Range request to the content-location resource to complete the download of the response.


## Closing the Operation

The client MAY acknowledge it has fully consumed to the completed operation by issuing a `DELETE` request on the response-message-location resource. Clients SHOULD issue a DELETE if they do not anticipate needing to request the document in the future.


## Registrations

### Request-Content-Location

This response header specifies the server-specified location that the request message-body will be available at.

If the client sent `Expect: 100-continue` with a `Prefer: resume` preference, this header SHOULD be sent in the `100 Continue` intermediate response headers.

If the server does not normally retain the contents of an upload (for example, if the upload is only used to make a digest, or is quickly encrypted), the server MAY choose to only support a HEAD request, if it can respond with the correct `Content-Length` of the upload. GET requests in this case would return `405 (Method Not Allowed)` with an `Allow: HEAD, PATCH` header.


### Response-Message-Location

This response header specifies the server-specified location where a copy of the final response will be made available at. This document SHOULD be `message/http` (regardless of protocol, including HTTP/2), and MAY include the response body.

This header is used by clients to determine the final result of a request that has been interrupted.


### "resume" preference

The `resume` HTTP Preference specifies how a server should handle a request that was terminated before it was finished by the client.

* `resume=save-incomplete` indicates the server should save the partial upload for a period of time so that a subsequent request can complete it.
* `resume=ignore-incomplete` indicates the server should discard the operation; this is useful if the client only intends to support retrying failed requests from the beginning.

Any presence of the `resume` preference is a request to send `Request-Content-Location`, `Response-Message-Location`, and `Content-Location` headers. An unspecified parameter value defaults to `save-incomplete`.


## Security Considerations

### Privacy concerns

Using the resumable requests feature potentially makes the request available to the other user-agents.

Origin servers SHOULD mint unpredictable URIs with high entropy, though note that this is not a guarantee of privacy.

An alternative to consider is issuing the `Request-Content-Location` and `Response-Message-Location` with a userinfo component specific to these two resources, which is typically not stored in logs, and can be stored in hashed form on the origin server; the user agent would then make follow-up requests with an `Authorization` header.

### State storage

In order to allow subsequent HTTP requests to finish the request, origin servers have to store the processing state of the request. In large applications with many load-balanced processing nodes, this state will usually be stored in a database somewhere. This is a new consideration, and a new attack vector that developers will have to secure when designing server software.

