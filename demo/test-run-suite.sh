#!/bin/bash
NODEJS=./node

# Start server
$NODEJS httpd.js &
HTTPD_PID=$!

# Run the client-library tests (i.e. a server that ensures the client is behaved correctly)
curl -XPOST http://localhost:18080/test/reset --retry-connrefused --retry 20 --retry-delay 1 -s
$NODEJS test-runner-client.js 'http://localhost:18080'
RESULT_1=$?

echo ""
echo "Results:"
curl -v http://localhost:18080/test/status

# Run the server tests (the client that ensures the server is behaved correctly)
# $NODEJS test-server.js 'http://localhost:18080'
# RESULT_2=$?

# Clean up
kill $HTTPD_PID
wait

if [ $RESULT_1 -ne 0 ]; then exit $RESULT_1; fi
# if [ $RESULT_2 -ne 0 ]; then exit $RESULT_2; fi
