---
title: Partial Uploads in HTTP
docname: draft-wright-http-partial-upload
category: exp
abbrev: HTTP Progress
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
  RFC7230: HTTP/1.1 Syntax
  RFC7231: HTTP/1.1 Semantics
  RFC8187: Indicating Character Encoding and Language for HTTP Header Field Parameters
  RFC7240: Prefer Header for HTTP

informative:

--- abstract

This document specifies a new media type intended for use in PATCH payloads that allows a resource to be uploaded in several segments, instead of a single large request.

--- middle


## Introduction

Also known as partial uploads, segmented upload, or resumable uploads.

HTTP is a stateless protocol, which implies that if a request is interrupted, there can be no way to resume it. This is not normally an issue if there is an alternate way of arriving to the desired state from an incomplete state transition. For example if a download is interrupted, the user-agent may request just the missing parts in a Range request. However, if an upload is interrupted, no method exists for the client to synchronize its state with the server and only upload the remaining data, the entire request must be canceled and retried. This document standardizes a media type for PATCH and a new status code for uploading new resources over several segmented requests.


## Modifying a content range with PATCH

The PATCH method allows a client to modify a resource in a specific way, as specified by the request payload.

The client may use the `message/byteranges` media type, defined below, to patch a single range; or the client may use the existing `multipart/byteranges` media type to change one or more ranges in a single request.


## Segmented upload with PATCH

As an alternative to using PUT to create a new resource, the contents of a resource may be uploaded in _segments_, each written across several PATCH requests.

The first PATCH request creates the resource and uploads the first segment. To ensure the resource does not exist, the request SHOULD include `If-None-Match: *`. The request payload is a `message/byteranges` document containing the first segment of the resource to be uploaded, and the total length of the resource to be uploaded. Upon processing, the server returns `2__ Incomplete Content` indicating the request is error-free up to this point, but that more writes are expected before anything more can be done with the resource.

Additional segments are uploaded with the same format.

When the final segment is uploaded, the server detects the resource is completely uploaded, and returns the final status code.

If the client loses the state of the upload, or the connection is terminated, the user agent can re-synchronize by issuing a `HEAD` request for the resource to get the current uploaded length. The response will typically be 200 (OK) or 2__ (Incomplete Content). The user agent may resume uploading the document from that offset.


## Registrations

### 2__ (Incomplete Content) status code

The 2__ (Incomplete Content) status code indicates that while the request succeeded, the request target is not ready for use, and the server is awaiting more data to be written.

In response to a GET request, representations returned with this status code might not be valid according to their media type, but could become valid once more data is appended.

In response to a PATCH request, it means the operation succeeded, but more uploads are necessary before the server can do anything else with the resource.

This is a 2xx class status because it indicates the request was filled, and may safely be handled the same as a 200 (OK) response. However, it is only expected to be seen by clients making partial uploads; clients not expecting an this status MAY treat it as an error.

Responses to a HEAD request MUST return the same end-to-end headers as a GET request. Normally, HTTP allows HEAD responses to omit certain header fields related to the payload; however Content-Length and Content-Range are essential fields for synchronizing the state of partial uploads. Hop-by-hop headers may still be omitted.


### message/byteranges media type

The `message/byteranges` media type is a media type that patches the defined byte range to some specified contents. It follows the syntax of a MIME message, and MUST include the Content-Range header field. It is similar to the `multipart/byteranges` media type, except it omits the multipart separator, and so only allows a single range to be specified.

A patch is applied to a document by changing the range of bytes to the contents of the patch message payload. Servers MAY treat an invalid or nonexistent range as an error.


## Security Considerations

### Unallocated ranges

Servers SHOULD only allow patches to ranges starting inside or immediately after the end of the representation. To prevent disclosing the contents of memory, servers MUST fill undefined ranges with predictable data (e.g. zeros).


--- back
