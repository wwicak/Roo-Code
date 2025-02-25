# System Patterns

## System Architecture

### Core Components

1. **Extension Core (src/core/)**

    - Cline.ts: Main extension logic
    - CodeActionProvider.ts: VSCode code actions
    - EditorUtils.ts: Editor manipulation utilities
    - Mode validation and management

2. **API Integration (src/api/)**

    - Multiple AI provider support
    - Request transformation layers
    - Stream handling
    - Response formatting

3. **Services (src/services/)**

    - Browser integration
    - Checkpoint management
    - MCP (Model Context Protocol) handling
    - Ripgrep integration
    - Tree-sitter parsing

4. **WebView UI (webview-ui/)**
    - React-based interface
    - TypeScript implementation
    - Tailwind CSS styling
    - Component-based architecture

### Integration Points

1. **VSCode Integration**

    - Editor manipulation
    - Terminal management
    - Workspace handling
    - Theme integration
    - Diagnostic support

2. **File System Operations**
    - Safe file manipulation
    - Directory management
    - Path resolution
    - Git integration

## Key Technical Decisions

### 1. TypeScript Usage

- Strong type safety
- Enhanced developer experience
- Better code organization
- Improved maintainability

### 2. React for UI

- Component-based architecture
- State management
- Virtual DOM efficiency
- Developer familiarity

### 3. Testing Strategy

- Jest for unit testing
- Integration test support
- Mock implementations
- High coverage requirements

### 4. AI Provider Integration

- Provider-agnostic design
- Unified interface
- Stream processing
- Error handling

### 5. MCP (Model Context Protocol)

- Extensible tool system
- Resource management
- Server communication
- Custom tool development

## Design Patterns

### 1. Command Pattern

- Command registration
- Action execution
- State management
- Undo support

### 2. Observer Pattern

- Event handling
- State updates
- UI synchronization
- Extension communication

### 3. Strategy Pattern

- Different modes of operation
- AI provider selection
- Diff strategies
- File handling approaches

### 4. Factory Pattern

- Provider creation
- Tool instantiation
- Service initialization
- UI component generation

## Component Relationships

### 1. Extension Core ↔ API Layer

- Provider communication
- Request handling
- Response processing
- Error management

### 2. Core ↔ Services

- Tool execution
- Resource access
- File operations
- State management

### 3. Core ↔ WebView

- UI updates
- Command execution
- State synchronization
- Event handling

### 4. Services ↔ External Systems

- AI provider integration
- File system access
- Git operations
- VSCode API usage
