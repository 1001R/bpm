#!/bin/sh

npm run build
npx firebase deploy --only hosting
