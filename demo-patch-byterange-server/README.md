# Byte range PATCH demo

This directory contains a sample program that implements the byterange media type in PATCH requests.

# Running the Server

```shell
node httpd.js
```

# Making a Request

There's two utilities used to make a request to the server:

* client.sh — shell script using curl to make a request
* client.js — Node.js script to make a request

## Example use with client.js

```
node httpd.js &
rm -f index.txt # Remove if previously created
node client.js '/index.txt' 0 '0123456789'
node client.js '/index.txt' 10 '0123456789'
cat index.txt
```

## Example use with client.sh

```
node httpd.js &
rm -f index.txt # Remove if previously created
./client.sh '/index.txt' 0 '0123456789'
./client.sh '/index.txt' 10 '0123456789'
cat index.txt
```
