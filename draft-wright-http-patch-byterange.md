---
title: Byte Range PATCH
docname: draft-wright-http-patch-byterange-latest
submissiontype: independent
category: exp
ipr: trust200902
workgroup: HTTP APIs
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
  RFC2046: "Multipurpose Internet Mail Extensions (MIME) Part Two: Media Types"
  RFC4918: "HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)"
  RFC5789: "PATCH Method for HTTP"
  RFC9292: "Binary Representation of HTTP Messages"



--- abstract

This document specifies a media type for PATCH payloads that overwrites a specific byte range, to allow random access writes, or allow a resource to be uploaded in several segments.



--- middle

# Introduction

Filesystem interfaces typically provide some way to write at a specific position in a file. While HTTP supports reading byte range offsets using the Range header ({{Section 14 of RFC9110}}), this technique cannot generally be used in PUT, because the server may ignore the Content-Range header while executing the write, causing data corruption. However, by using a method and media type that the server must understand, writes to byte ranges with Content-Range semantics becomes possible.

This media type is intended for use in a wide variety of applications where overwriting specific parts of the file is desired. This includes idempotently writing data to a stream, appending data to a file, overwriting specific byte ranges, or writing to multiple regions in a single operation (for example, appending audio to a recording in progress while updating metadata at the beginning of the file).

It is particularly designed to recover from interrupted uploads. Since HTTP is stateless, clients can recover from an interrupted connection by making a request that completes the partial state change. For downloads, the Range header allows a client to download only the unknown data. However, if an upload is interrupted, no mechanism exists to upload only the remaining data; the entire request must be retried.

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

Although the Content-Range field cannot be used in the request headers without risking data corruption, it may be used in conjunction with the PATCH method {{RFC5789}} as part of a media type whose semantics writes a subset of a document, at a particular byte offset. This document re-uses the "multipart/byteranges" media type, and defines the "message/byterange" media type, for this purpose.

Servers MUST read a Content-Range field from the patch document that completely indicates the parts of the target resource to write to, and produce a 422 or 400 error if none is found. (This would mean the client may be using a yet-undefined mechanism to specify the target range.)

The client MUST NOT send the unsatisfied-range form (e.g. `bytes */1000`); this is not meaningful.

The client MAY indicate the anticipated final size of the document by providing the complete-length form, for example `bytes 0-11/12`. This value does not affect the success of the write, however the server MAY use it for other purposes, especially for preallocating an optimal amount of space, and deciding when an upload in multiple parts has finished.

If the client does not know or care about the final length of the document, it MAY use `*` in place of complete-length. For example, `bytes 0-11/*`. Most random access writes will follow this form.

Other "Content-" fields in the patch document have the same meaning as if used in the headers of a PUT request.

Servers SHOULD NOT accept requests that begin writing after the end of the resource. This would create a sparse file, where some byte ranges are undefined, and HTTP semantics currently has no way of representing such undefined ranges. For example, writing at byte 601 of a resource where bytes 0-599 are defined; this would leave byte 600 undefined.

Servers that accept sparse writes MUST initialize unwritten regions to not disclose contents of existing storage. From the client's perspective, this is equivalent to another client or the server writing out any regions that it did not write to. Future specifications may define a way for the server to list uninitialized regions, for the client to act on, without needing to perform this step.


## The multipart/byteranges media type

The following is a request with a "multipart/byteranges" body to write two ranges in a document:

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

The syntax for multipart messages is defined in {{RFC2046, Section 5.1.1}}.



## The message/byterange media type

When making a request, there is no need for a multipart boundary, and this may be optimized away. This document defines a new media type "message/byterange" with the same semantics as a single byte range in a multipart/byteranges message, but with a simplified syntax.

The "message/byterange" form may be used in a request as so:

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

The syntax is defined in {{messagebyterange-media-type}}.


## Range units

Currently, the only defined range unit is "bytes", however this may be other, yet-to-be-defined values.

In the case of "bytes", exactly those bytes are changed. However, future units may define write semantics different from a read, if symmetric behavior would not make sense. For example, if a Content-Range field identifies an item in a JSON array, a write to this item may add or remove a leading or trailing comma, not technically part of the item itself, in order to keep the resulting document well-formed.


# Segmented uploads with PATCH

As an alternative to using PUT to create a new resource, the contents of a resource may be uploaded in segments, each written across several PATCH requests.

A user-agent may also use PATCH to recover from an interrupted PUT request, if it was expected to create a new resource. The server will store the data sent to it by the user agent, but will not finalize the upload until the final length of the document is known and received.

1. The client makes a PUT or PATCH request to a URL, a portion of which is randomly generated by the client, or computed based on a cryptographic hash of the document (the exact algorithm is unimportant to the server and need not be indicated). This first request creates the resource, and should include `If-None-Match: *` to verify the target does not exist. If a PUT request, the server reads the Content-Length header and stores the intended final length of the document. If a PATCH request, the "Content-Range" field in the "message/byterange" patch is read for the final length. The final length may also be undefined, and defined in a later request.

2. If any request is interrupted, the client may make a HEAD request to determine how much, if any, of the previous response was stored, and resumes uploading from that point. The server will return 200 (OK), but this may only indicate the write has been saved; the server is not obligated to begin acting on the upload until it is complete.

3. If the client sees from the HEAD response that additional data remains to be uploaded, it may make a PATCH request to resume uploading. Even if no data was uploaded or the resource was not created, the client should attempt creating the resource with PATCH to mitigate the possibility of another interrupted connection with a server that does not save incomplete transfers. However if in response to PATCH, the server reports 405 (Method Not Allowed), 415 (Unsupported Media Type), or 501 (Not Implemented), then the client must resort to a PUT request.

4. The server detects the completion of the final request when the current received data matches the indicated final length. For example, a `Content-Range: 500-599/600` field is a write at the end of the resource. The server processes the upload and returns a response for it.

For building POST endpoints that support large uploads, clients can first upload the data to a scratch file as described above, and then process by submitting a POST request that links to the scratch file.

For updating an existing large file, the client can upload to a scratch file, then execute a MOVE ({{Section 9.9 of RFC4918}}) over the intended target.



## Example

A single PUT request that creates a new resource may be split apart into multiple PATCH requests. Here is an example that uploads a 600-byte document across three 200-byte segments.

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

The "message/byterange" media type patches the defined byte range to some specified contents.  It is similar to the "multipart/byteranges" media type, except it omits the multipart separator, and so only allows a single range to be specified.

It follows the syntax of HTTP message headers and body. It MUST include the Content-Range header field. If the message length is known by the sender, it SHOULD contain the Content-Length header field. Unknown or nonapplicable header fields MUST be ignored.

The field-line and message-body productions are specified in [RFC9112].

~~~ abnf
byterange-document = *( field-line CRLF )
                     CRLF
                     [ message-body ]
~~~

This document has the same semantics as a single part in a "multipart/byteranges" document ({{Section 5.1.1 of RFC2046}}) or any response with a 206 (Partial Content) status code ({{Section 15.3.7 of RFC9110}}). A "message/byterange" document may be trivially transformed into a "multipart/byteranges" document by prepending a dash-boundary and CRLF, and appending a close-delimiter (a CRLF, dash-boundary, terminating "`--`", and optional CRLF).


## message/byterange+bhttp media type

The "message/byterange+bhttp" media type patches the defined byte range to some specified contents.  It has the same semantics as "message/byterange", but follows a syntax closely resembling "message/bhttp"

```
Request {
  Framing Indicator (i) = 8,
  Known-Length Field Section (..),
  Known-Length Content (..),
  Padding (..),
}

Known-Length Field Section {
  Length (i),
  Field Line (..) ...,
}

Known-Length Content {
  Content Length (i),
  Content (..),
}

Field Line {
  Name Length (i) = 1..,
  Name (..),
  Value Length (i),
  Value (..),
}
```

# Caveats

There is no standard way for a Content-Range header to indicate an unknown or indefinite length response starting at a certain offset; the design of partial content messages requires that the sender know the total length before transmission. However it seems like it should be possible to generate an indefinite partial content response (e.g. return a continuously growing audio file starting at a 4MB offset). Fixing this would require a new header, update to HTTP, or a revision of HTTP.

This pattern can enable multiple, parallel uploads to a document at the same time. For example, uploading a large log file from multiple devices. However, this document does not define any ways for clients to track the unwritten regions in sparse documents, and the existing conditional request headers are designed to cause conflicts. This may be addressed in a later document.

Servers do not necessarily have to save the results of an incomplete upload; since most clients prefer atomic writes, many servers will discard an incomplete upload. A mechanism to indicate a preference for atomic vs. non-atomic writes may be defined at a later time.

When a PUT that updates an existing file has been interrupted, it may not possible to know how much of the request was received by the server, and which content already existed. This requires use of a more sophisticated synchronization mechanism, that may use a byte range PATCH, but is otherwise outside the scope of this document.



# Security Considerations

## Unallocated ranges

The byterange media type technically permits writes to offsets beyond the bound of the file. This may have behavior not be predictable by the user.

Servers will normally only allow patch ranges to start inside or at the immediate end of the representation. Servers supporting sparse files MUST NOT return uninitialized memory or storage contents. Uninitialized regions may be initialized prior to executing the sparse write, or this may be left to the filesystem if it can guarantee this behavior.


--- back
