---
title: Partial and Resumable Requests in HTTP
docname: draft-wright-http-resume-request-latest
category: exp
ipr: trust200902
workgroup: HTTP
keyword:
  - Internet-Draft
  - HTTP
stand_alone: yes
pi: [toc, sortrefs, symrefs]

author:
 -
    ins: A. Wright
    name: Austin Wright
    email: aaa@bzfx.net

normative:
  RFC2119: Key words for use in RFCs
  RFC7231: HTTP/1.1 Semantics
  RFC7240: Prefer Header for HTTP

--- abstract

This document defines a mechanism for following the real-time progress of long-running operations over HTTP.

--- middle

# Introduction

This document describes a standard mechanism by which servers can address the location where a request is being processed, allowing subsequent requests to complete it, if interrupted.

HTTP is a stateless protocol [RFC7231], which implies that if a request is interrupted, there can be no way to resume that request.
This is not normally an issue if there is an alternate way of arriving at the desired state from an incomplete state transition.
For example, if a download is interrupted, the user-agent may request just the missing parts in a Range request.
However, if an unsafe request is interrupted before the client receives the response, there is no standard way of determining the result of that operation;
the user agent is forced to read the state of the server before deciding on a course of action, which is often implementation-specific.
This document standardizes a way of resuming a previous upload, and re-requesting the result of an operation.

## Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL
NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED",
"MAY", and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 {{!RFC2119}} {{!RFC8174}} when, and only when, they
appear in all capitals, as shown here.

This document uses ABNF as defined in {{!RFC5234}} and imports grammar rules from {{!RFC7230}}.

For brevity, example HTTP requests or responses may add newlines or whitespace,
or omit some headers necessary for message transfer.

# Resumable Requests

 ## Continue Outstanding Request Workflow

This document specifies how HTTP requests may be resumed, by treating a request or response as an HTTP resource unto itself.

When a user-agent wants to make a lengthy upload, it is typical to include `Expect: 100-continue` and wait for the server to validate the request headers before allowing the upload to proceed. This workflow takes advantage of this fact, and along with this response, includes instructions on how to resume the upload if it becomes interrupted, by providing a URI representing the address where the upload is being stored.

The initial request is done with `Expect: 100-continue` with `Prefer: resume`, which will return a `100 Continue` interim response with `Request-Content-Location`, `Response-Message-Location`, and/or `Content-Location` headers.

If the request was interrupted before `100 Continue` was received, then the server state has not changed yet, and the client may re-issue the request.

If the request is interrupted while uploading the request payload, the request-content-resource may be queried to determine if the server received the full contents. If not, the upload may be completed by issuing a PATCH request to complete the contents. This step may re-tried until the client has fully uploaded the data.

If the upload was received by the server but the response was not received by the client, the client may query the response message resource to determine if a response is available. This response will be in a `message/http` format so that it may be streamed into a standard HTTP parser, typically the same parser being used to communicate with the server.

If the response headers were received, but the payload was only partially received, the client may make a Range request to the content-location resource to complete the download of the response.


## Closing the Operation

The client MAY acknowledge it has fully consumed the completed operation by issuing a `DELETE` request on the response-message-location resource. Clients SHOULD issue a DELETE if they do not anticipate needing to request the document in the future.


# Registrations

## Request-Content-Location

This response header specifies the location that represents the request message-body. URI references are resolved against the request URI.

If the client sent `Expect: 100-continue` with a `Prefer: resume` preference [RFC7240], this header SHOULD be sent in the `100 Continue` interim response headers.

If the server does not normally retain the contents of an upload (for example, if the upload is only used to make a digest, or is quickly encrypted), the server MAY choose to only support a HEAD request, if it can respond with the correct `Content-Length` of the upload. GET requests in this case would return `405 (Method Not Allowed)` with an `Allow: HEAD, PATCH` header.

~~~abnf
Request-Content-Location = URI-reference
~~~

This is introduced as a header and not a Link relation because it is specific to the specific message, and not necessarily the representation that the request is about.


## Response-Message-Location

This response header specifies the location where a copy of the final response message will be made available at. This document SHOULD be `message/http` (regardless of protocol, including HTTP/2), and MAY include the response body.  URI references are resolved against the request URI.

When the response to the client's request is interrupted, clients will use this header to retreive the response message in a separate request.

~~~abnf
Response-Message-Location = URI-reference
~~~

This is introduced as a header and not a Link relation because it is specific to the specific message, and not necessarily the representation that the request is about.


## "resume" preference

The `resume` HTTP Preference specifies how a server should handle a request that was terminated before it was finished by the client.

* `resume=save-incomplete` indicates the server should save the partial upload for a period of time so that a subsequent request can complete it.
* `resume=ignore-incomplete` indicates the server should discard the operation; this is useful if the client only intends to support retrying failed requests from the beginning.

Any presence of the `resume` preference is a request to send `Request-Content-Location`, `Response-Message-Location`, and `Content-Location` headers. An unspecified parameter value defaults to `save-incomplete`.


## Acknowledge

This response header is intended to be used in `100 Continue` interim responses to confirm to the client that some amount of data has been persisted by the server. Clients MAY use this header to free buffered data.

~~~abnf
Acknowledge = 1*DIGIT
~~~


## "acknowledge" preference

The "acknowledge" HTTP preference indicates the client would like to receive periodic `100 Continue` responses with an `Acknowledge` header in acknowledgement of received data.


# Security Considerations

## Privacy concerns

Using the resumable requests feature potentially makes the request available to the other user-agents.

Origin servers SHOULD mint unpredictable URIs with high entropy (unguessable components), though note that this is not a guarantee of privacy.

Origin servers SHOULD verify that the user who started the request is the same user resuming the request.

In the absence of user authentication, an alternative could be to send `Request-Content-Location` and `Response-Message-Location` with a userinfo component specific to these two resources (stored in hashed form on the origin server); the user agent would then make follow-up requests with an `Authorization` header.

## State storage

In order to allow subsequent HTTP requests to finish the request, origin servers have to store the processing state of the request. In large applications with many load-balanced processing nodes, this state will usually be stored in a database somewhere. This is a new consideration, and a new attack vector that developers will have to secure when designing server software.


--- back
