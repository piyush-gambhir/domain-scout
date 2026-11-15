package api

//go:generate go tool oapi-codegen -config oapi-codegen.yaml ../../../../packages/contracts/openapi.json
//go:generate go run ../../scripts/strip-comments -file api.gen.go
