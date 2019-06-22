# Resumable and Partial Operations in HTTP

This repository hosts a suite of documents that assists user agents in making large or long-running requests that manipulate the server state.

It constists of three documents:

* [Partial upload](draft-wright-http-partial-upload.md) - defines a media type and status code for uploading a portion of a request payload
* [Resumable requests](draft-wright-http-resume-request.md) - defines two headers that specify where a partially finished request is stored and may be resumed at.
* [Progress of long-running operations](draft-wright-http-progress.md) - defines serveral features that provides real-time updates of an operation being run by the server

It supports the following use cases:


## Segmented new file creation

Create a new document using PATCH with a `message/byteranges` media type.


## Patching a specific byte range

Use PATCH with an existing resource using the `message/byteranges` or `multipart/byteranges` media types.


## Resume interrupted request

When a request begins, the server may provide a URI representing the location where the upload is being stored (either in memory or on disk). The request may be continued with a PATCH request to this resource.


## Progress on ongoing request

Allows a server to report the current status of an ongoing request.


## Resume interrupted response
If a response has been fully written but is interrupted before the final response is ready, the `Response-Message-Location` header specifies a request where the final status will be available at.

If the final headers have been written but the payload transfer was interrupted, the client may additionally use the `Content-Location` header as already defined.

