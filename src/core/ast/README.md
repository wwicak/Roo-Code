# AST-LLM Integration

This module provides integration between Abstract Syntax Tree (AST) parsing and Large Language Models (LLMs) for safe and reliable code editing.

## Overview

The AST-LLM integration provides a framework for safely modifying code using LLMs by leveraging AST parsing to:

1. Accurately locate and identify functions and methods in code
2. Create backups before making changes
3. Validate semantic and structural integrity of changes
4. Roll back changes when needed
5. Improve code modification accuracy

## Components

The integration consists of several key components:

- **ClineAstIntegration**: The main integration class that coordinates all AST services
- **AstService**: Provides AST parsing and node manipulation functionality
- **AstRollbackManager**: Manages backups and restoration of modified files
- **AstCacheManager**: Caches AST data for improved performance
- **SemanticValidator**: Validates the semantic integrity of code changes
- **SymbolDatabase**: Manages code symbols and their relationships

## Configuration

The integration can be configured with the following options:

```typescript
interface ClineAstIntegrationConfig {
	embeddingApiKey?: string // API key for embedding service
	maxBackupsPerFile?: number // Maximum number of backups per file (default: 10)
	semanticThreshold?: number // Threshold for semantic similarity (default: 0.85)
	structuralThreshold?: number // Threshold for structural integrity (default: 0.7)
	enableAstCaching?: boolean // Whether to enable AST caching (default: true)
}
```

## Usage

### Basic Usage

To use the AST integration in Cline:

```typescript
// Initialize the integration
const astIntegration = new ClineAstIntegration({
	embeddingApiKey: "your-api-key",
	maxBackupsPerFile: 10,
	semanticThreshold: 0.85,
	structuralThreshold: 0.7,
	enableAstCaching: true,
})

// Modify a function body
const result = await astIntegration.modifyFunctionBody(
	cwd, // Current working directory
	relativePath, // Relative path to the file
	functionIdentifier, // Function identifier (e.g., "Class.method" or "functionName")
	newBody, // New function body
)

if (result.success) {
	console.log("Function modified successfully!")
} else {
	console.error("Failed to modify function:", result.message)
	console.log("Validation details:", result.validationDetails)
}
```

### Rolling Back Changes

To roll back changes made to a file:

```typescript
const rolledBack = await astIntegration.rollbackChange(relativePath)
if (rolledBack) {
	console.log("Changes rolled back successfully")
}
```

### Getting Backup Information

To retrieve information about available backups:

```typescript
const backupInfo = await astIntegration.getBackupInfo(relativePath)
console.log(`Available backups: ${backupInfo.count}`)
console.log("Backup timestamps:", backupInfo.backups)
```

### Updating Configuration

To update configuration settings:

```typescript
astIntegration.updateConfiguration({
	semanticThreshold: 0.9,
	maxBackupsPerFile: 20,
})
```

## Function Identifiers

Function identifiers follow these formats:

- Functions: `functionName`
- Class methods: `ClassName.methodName`
- Static methods: `ClassName.staticMethodName`
- Nested classes: `OuterClass.InnerClass.methodName`

## Integration with Cline

The AST integration is automatically initialized in the Cline constructor with configurable options:

```typescript
const cline = new Cline({
	// Other options...
	embeddingApiKey: "your-api-key",
	astMaxBackupsPerFile: 10,
	astSemanticThreshold: 0.85,
	astStructuralThreshold: 0.7,
	enableAstCaching: true,
})
```

## Error Handling

The integration provides detailed error messages and suggestions when operations fail, including:

- File not found errors
- Parse errors
- Node identification errors
- Validation errors
- Reconstruction errors

## Contributing

When extending this module, please:

1. Add appropriate tests for new functionality
2. Follow the established error handling patterns
3. Update documentation for public APIs
4. Maintain the backup and rollback functionality for safety
