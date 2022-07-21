---
title: Byte Range PATCH
docname: draft-wright-http-patch-byterange-latest
submissiontype: independent
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
  RFC9110: HTTP Semantics
  RFC9112: HTTP/1.1

informative:
  RFC4918: HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)
  RFC5789: PATCH Method for HTTP



--- abstract

This document specifies a new media type intended for use in PATCH payloads that overwrites a specific byte range, to allow random access writes, or allow a resource to be uploaded in several segments.



--- middle

# Introduction

HTTP has many features analogous to a filesystem, including reading, writing, metadata, and file listing {{RFC4918}}. While HTTP supports reading byte range offsets using the Range header ({{Section 14 of RFC9110}}), it cannot be used in PUT, because the write would still be executed even when the byte range is unsupported. However, by using a method and media type that the server must understand, writes to byte ranges with Content-Range header semantics is possible.

This may be used as part of a technique for resuming interrupted uploads. Since HTTP is a stateless protocol, there is no way to resume an interrupted request, instead the client can make a request that completes the partial state change. For downloads, the Range header allows a client to download only the unknown data. However, if an upload is interrupted, no method exists to upload only the remaining data; the entire request must be retried.

Byte range patches may be used to "fill in these gaps."



## Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL
NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED",
"MAY", and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 {{!RFC2119}} {{!RFC8174}} when, and only when, they
appear in all capitals, as shown here.

This document uses ABNF as defined in {{!RFC5234}} and imports grammar rules from {{!RFC9112}}.

For brevity, example HTTP requests or responses may add newlines or whitespace,
or omit some headers necessary for message transfer.



# Modifying a content range with PATCH

Although the Content-Range header cannot be used in requests directly, it may be used in conjunction with the PATCH method {{RFC5789}} and a media type that specifies a subset of bytes in a document, at a particular offset. This document re-uses the `multipart/byteranges` media type, and defines the `message/byterange` media type, for this purpose.

Servers SHOULD NOT accept requests that begin writing after the end of the file. This would create a sparse file, where some byte ranges are undefined, and HTTP semantics currently has no way of representing such undefined ranges. For example, writing at byte 601 of a file where bytes 0-599 are defined; this would leave byte 600 undefined.

Servers that accept sparse writes MUST initialize unwritten regions to not disclose contents of prior writes. This is equivalent to another client or the server writing out any regions that haven't been written by the client; future specifications may define a way for the server to list uninitialized regions, for the client to act on, without needing to perform this step.

Servers MUST read a Content-Range field from the patch document that completely indicates the parts of the target resource to write to, and produce a 422 or 400 error if none is found. (This would mean the client may be using a yet-undefined mechanism to specify the target range.)

Currently, the only defined range unit is "bytes", however this may be other, yet-to-be-defined values.

In the case of "bytes", exactly those bytes are changed. However, a unit MAY define write semantics different from a read. For example, if a Content-Range field identifies an item in a JSON array, a write may add or remove a leading or trailing comma, not technically part of the item itself, in order to keep the resulting document valid.

The client MUST NOT send an `unsatisfied-range` form (e.g. `bytes */1000`), this is not meaningful.

The client MAY indicate the anticipated final size of the document by providing a `complete-length`, for example `bytes 0-9/10`. This value does not affect the success of the write, however the server MAY use it for other purposes, especially for deciding when an upload in multiple parts has finished.

If the client does not know or care about the final length of the document, it MAY use `*` in place of `complete-length`. For example, `bytes 0-9/*`. Most random access writes will follow this form.

Other `Content-` fields in the patch document have the same meaning as if used in the headers of a PUT request.


## The multipart/byteranges media type

The following is a request with a `multipart/byteranges` body to write two ranges in a document:

~~~ example
PATCH /uploads/foo HTTP/1.1
Content-Type: multipart/byteranges; boundary=THIS_STRING_SEPARATES
Content-Length: 206
If-Match: "xyzzy"
If-Unmodified-Since: Sat, 29 Oct 1994 19:43:31 GMT

--THIS_STRING_SEPARATES
Content-Range: bytes 2-6/25
Content-Type: text/plain

23456
--THIS_STRING_SEPARATES
Content-Range: bytes 17-21/25
Content-Type: text/plain

78901
--THIS_STRING_SEPARATES--
~~~


## The message/byterange media type

When making a request, there is no need for a multipart boundary, and this may be optimized away. This document defines a new media type `message/byterange` with the same semantics as a single byte range in a multipart/byteranges message, but with a simplified syntax.

The `message/byterange` form may be used in a request as so:

~~~ example
PATCH /uploads/foo HTTP/1.1
Content-Type: message/byterange
Content-Length: 272
If-Match: "xyzzy"
If-Unmodified-Since: Sat, 29 Oct 1994 19:43:31 GMT

Content-Range: bytes 100-299/600
Content-Type: text/plain

[200 bytes...]
~~~

This represents a request to modify a 600-byte document, overwriting 200 bytes of it, starting at a 100-byte offset.



# Segmented uploads with PATCH

As an alternative to using PUT to create a new resource, the contents of a resource may be uploaded in segments, each written across several PATCH requests.

A user-agent may use PATCH to recover an upload to an interrupted PUT or PATCH request. The server will store the data sent to it by the user agent, but will not finalize the upload until the final length of the document is known and received.

1. The client makes a PUT or PATCH request to a URL, a portion of which is randomly generated by the client, or computed based on a cryptographic hash of the document (the exact algorithm is unimportant to the server and need not be indicated). If a PUT request, the `Content-Length` header is read by the server and stored as the intended final length of the document. If a PATCH request, the Patch field in the `message/byterange` is read for the final length. The final length may also be undefined, and defined in a later request. This first request also has the effect of creating the file.

2. If any request is interrupted, the client may make a HEAD request to determine how much, if any, of the previous response was stored, and resumes uploading from that point. The server will return 200 (OK), but this may only indicate the write has been saved; the server is not obligated to begin acting on the upload until it is complete.

3. The server detects the completion of the final request when the current received data matches the indicated final length. For example, a `Range: 500-599/600` header indicates a write at the end of the file. The server processes the upload and returns a response for it.

For building POST endpoints that support large uploads, clients can first upload the data, and then process it in a POST request that points to the upload URL.



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

This request allocates a 600 byte document, and uploading the first 200 bytes of it. The server responds with 200, indicating that the complete upload was stored.

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

This second request also returns 200 (OK).

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

The server responds with 200 (OK). Since this completely writes out the 600-byte document, the server may also perform final processing, for example, checking that the document is well formed. The server MAY return an error code if there is a syntax or other error, or in an earlier response as soon as it it able to detect an error, however the exact behavior is left undefined.



# Registrations

## message/byterange media type

The `message/byterange` media type patches the defined byte range to some specified contents.  It is similar to the `multipart/byteranges` media type, except it omits the multipart separator, and so only allows a single range to be specified.

It follows the syntax of HTTP message headers and body. It MUST include the Content-Range header field. If the message length is known by the sender, it SHOULD contain the Content-Length header field. Unknown or nonapplicable header fields MUST be ignored.

`field-line` and `message-body` are specified in [RFC9112].

~~~ abnf
byterange-document = *( field-line CRLF )
                     CRLF
                     [ message-body ]
~~~

A patch is applied to a document by setting the indicated range of bytes to the contents of the patch message payload. Servers MUST treat an invalid or nonexistent range as an error.



# Caveats

There is no standard way for a Content-Range header to indicate an unknown or indefinite length response starting at a certain offset; the design requires that the sender know the length of the document before transmission. Fixing this would require a new header or a revision of HTTP.

This pattern can enable multiple, parallel uploads to a document at the same time. For example, uploading a large log file from multiple devices. However, this document does not define any ways for clients to track the unwritten regions in sparse documents, and the existing conditional request headers will conflict in this usage. This may be addressed in a later document.

Servers do not necessarily have to save the results of an incomplete upload; some clients may prefer that most writes are atomic, and so servers would discard an incomplete request. A mechanism to indicate a preference for atomic vs. non-atomic writes may be defined at a later time.



# Security Considerations

## Unallocated ranges

The byterange media type technically permits writes to offsets beyond the bound of the file. This may have behavior not be predictable by the user.

Servers will normally only allow patch ranges to start inside or at the immediate end of the representation. Servers supporting sparse files MUST NOT return uninitialized memory or storage contents. Uninitialized regions may be initialized prior to executing the sparse write, or this may be left to the filesystem if it can guarantee this behavior.


--- back