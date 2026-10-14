#!/bin/bash
# Add /mcp/ location block to soncad nginx config

CONF="/etc/nginx/sites-available/soncad.dnaboy.org"

# Check if already added
if grep -q "location /mcp/" "$CONF"; then
    echo "/mcp/ route already exists in nginx config"
else
    sudo sed -i '/location \/api\//i\
    location /mcp/ {\
        proxy_pass http://127.0.0.1:3002;\
        proxy_http_version 1.1;\
        proxy_set_header Host $host;\
        proxy_set_header X-Real-IP $remote_addr;\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\
        proxy_set_header X-Forwarded-Proto $scheme;\
        proxy_set_header Connection "";\
        proxy_buffering off;\
        proxy_cache off;\
        chunked_transfer_encoding off;\
        proxy_read_timeout 300s;\
    }\
' "$CONF"
    echo "Added /mcp/ location block"
fi

sudo nginx -t && sudo systemctl reload nginx
echo "Done. Test with: curl -s https://soncad.dnaboy.org/mcp/ -X POST -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}'"
