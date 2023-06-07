---
title: Partial Uploads in HTTP
docname: draft-wright-http-partial-upload-latest
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
  RFC7230: HTTP/1.1 Syntax
  RFC7233: HTTP/1.1 Range Requests

informative:
  RFC5789: PATCH Method for HTTP

--- abstract

This document specifies a new media type intended for use in PATCH payloads that allows a resource to be uploaded in several segments, instead of a single large request.

--- middle

# Introduction

This introduces a mechanism that allows user agents to upload a document over several requests. Similar solutions have been known as partial uploads, segmented uploading, or resumable uploads.

HTTP is a stateless protocol, which implies that if a request is interrupted, there can be no way to resume it. This is not normally an issue if there is an alternate way of arriving to the desired state from an incomplete state transition. For example, if a download is interrupted, the user-agent may request just the missing parts in a Range request. However, if an upload is interrupted, no method exists for the client to synchronize its state with the server and only upload the remaining data; the entire request must be canceled and retried. This document standardizes a media type for PATCH and a new status code for uploading new resources over several segmented requests.

## Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL
NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED",
"MAY", and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 {{!RFC2119}} {{!RFC8174}} when, and only when, they
appear in all capitals, as shown here.

This document uses ABNF as defined in {{!RFC5234}} and imports grammar rules from {{!RFC7230}}.

For brevity, example HTTP messages may add folding whitespace,
or omit some headers necessary for message transfer.


# Modifying a content range with PATCH

The PATCH method {{RFC5789}} allows a client to modify a resource in a specific way, as specified by the request payload. This document formalizes the concept of using `multipart/byteranges` {{RFC7233}} as a patch file, allowing usage in PATCH; and introduces a simplified form `message/byterange` that only patches a single range.

The `message/byterange` form may be used in a request as so:

~~~ example
PATCH /uploads/foo HTTP/1.1
Content-Type: message/byterange
Content-Length: 283
If-Match: "xyzzy"
If-Unmodified-Since: Sat, 29 Oct 1994 19:43:31 GMT

Content-Range: bytes 100-299/600
Content-Type: text/plain
Content-Length: 200

[200 bytes...]
~~~

This request asks to modify a 600-byte document, overwriting 200 bytes of it, starting at a 100-byte offset.

# Segmented upload with PATCH

As an alternative to using PUT to create a new resource, the contents of a resource may be uploaded in segments, each written across several PATCH requests.

The first PATCH request creates the resource and uploads the first segment. To ensure the resource does not exist, the request SHOULD include `If-None-Match: *`. The request payload is a `message/byterange` document containing the first segment of the resource to be uploaded, and the total length of the resource to be uploaded. Upon processing, the server returns `2__ Sparse Resource` indicating the document is error-free up to this point, but that more writes are necessary before the resource will be considered fully written.

Additional segments are uploaded with the same format.

When the final segment is uploaded, the server detects the resource is completely uploaded, and returns the final status code.

If the client loses the state of the upload, or the connection is terminated, the user agent can re-synchronize by issuing a `HEAD` request for the resource to get the current uploaded length. The response will typically be 200 (OK) or 2__ (Sparse Resource). If 2__, the user agent may resume uploading the document from that offset.

## Example

A single PUT request that creates a new file can be split apart into multiple PATCH requests. Here is an example that uploads a 600-byte document across three 200-byte segments.

The first PATCH request creates the resource:

~~~ example
PATCH /uploads/foo HTTP/1.1
Content-Type: message/byterange
Content-Length: 281
If-None-Match: *

Content-Range: bytes 0-199/600
Content-Type: text/plain
Content-Length: 200

[200 bytes...]
~~~

This request allocates a 600 byte document, and uploading the first 200 bytes of it. The server responds with 2__ (Sparse Resource), indicating that the resource has been allocated and all uploaded data is saved, but acknowledging the more data must still be uploaded by the client.

Additional requests upload the remainder of the document:

~~~ example
PATCH /uploads/foo HTTP/1.1
Content-Type: message/byterange
Content-Length: 283
If-None-Match: *

Content-Range: bytes 200-399/600
Content-Type: text/plain
Content-Length: 200

[200 bytes...]
~~~

This second request also returns 2__ (Sparse Resource), since there are still 200 bytes that are not written to.

A third request uploads the final portion of the document:

~~~ example
PATCH /uploads/foo HTTP/1.1
Content-Type: message/byterange
Content-Length: 283
If-None-Match: *

Content-Range: bytes 200-399/600
Content-Type: text/plain
Content-Length: 200

[200 bytes...]
~~~

 Since the document is fully written to, the server responds with 200 (OK), the same response as if the entire 600 bytes were written in a PUT request.

# Registrations

## 2__ (Sparse Resource) status code

The 2__ (Sparse Resource) status code indicates that while the request succeeded, the request target is not ready for use, and the server is awaiting more data to be written.

In response to a GET request, representations returned with this status code might not be valid according to their media type, but could become valid once more data is appended.

In response to a PATCH request, it means the operation succeeded, but more uploads are necessary before the server can do anything else with the resource.

This is a 2xx class status because it indicates the request was filled as requested, and may safely be handled the same as a 200 (OK) response. However, it is only expected to be seen by clients making partial uploads; clients not expecting this status MAY treat it as an error.

Responses to a HEAD request MUST return the same end-to-end headers as a GET request. Normally, HTTP allows HEAD responses to omit certain header fields related to the payload; however Content-Length and Content-Range are essential fields for synchronizing the state of partial uploads. Hop-by-hop headers may still be omitted.

Several alternate names for this status code can be considered, including: Incomplete Content, Partial Resource, or Incomplete Upload.


## message/byterange media type

The `message/byterange` media type patches the defined byte range to some specified contents.  It is similar to the `multipart/byteranges` media type, except it omits the multipart separator, and so only allows a single range to be specified.

It follows the syntax of HTTP message headers and body. It MUST include the Content-Range header field. If the message length is known by the sender, it SHOULD contain the Content-Length header field. Unknown or nonapplicable header fields MUST be ignored.

`header-field` and `message-body` are specified in [RFC7230].

~~~ abnf
byterange-document = *( header-field CRLF )
                     CRLF
                     [ message-body ]
~~~

A patch is applied to a document by changing the range of bytes to the contents of the patch message payload. Servers MAY treat an invalid or nonexistent range as an error.


# Security Considerations

## Unallocated ranges

Servers must consider what happens when clients make writes to a sparse file.

Servers will normally only allow patch ranges to start inside or immediately after the end of the representation. Servers supporting sparse writes MUST NOT disclose the contents of memory. This may be done at file creation time, or left to the filesystem if it can guarantee this behavior.


--- back
