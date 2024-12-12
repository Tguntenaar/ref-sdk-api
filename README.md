# NEAR Token Swap API

A RESTful API service for token swaps and metadata on the NEAR blockchain, built with Express.js and TypeScript.

## Features

- Token metadata retrieval
- Whitelist tokens with balances and prices
- Token swap functionality
- Rate limiting
- CORS enabled
- Security headers with Helmet

## API Endpoints

### Get Token Metadata

```http
GET /api/token-metadata
```

Retrieve metadata for a specific token.

#### Query Parameters

- `token` (string, required): The ID of the token for which metadata is requested.

#### Response

Returns a JSON object containing the metadata of the specified token.
