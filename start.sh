#!/bin/bash
set -e

echo "Installing dependencies..."
cd portal
npm install

echo "Building frontend..."
npm run build:frontend

echo "Starting application..."
npm --prefix backend start
