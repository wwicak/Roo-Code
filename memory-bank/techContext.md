# Technical Context

## Technologies Used

### Core Technologies

1. **TypeScript**

    - Version: See package.json
    - Used for type-safe development
    - Both extension and webview

2. **Node.js**

    - Version: Specified in .nvmrc
    - Runtime environment
    - Package management

3. **VSCode Extension API**
    - Extension host integration
    - Editor manipulation
    - Workspace management

### Frontend Technologies

1. **React**

    - UI framework for webview
    - Component-based architecture
    - State management

2. **Tailwind CSS**
    - Utility-first CSS framework
    - Custom theme integration
    - VSCode theming support

### Build Tools

1. **esbuild**

    - Fast bundling
    - TypeScript compilation
    - Production optimization

2. **Vite**
    - Webview development
    - HMR support
    - Build optimization

### Testing

1. **Jest**

    - Unit testing framework
    - Mock system
    - Coverage reporting

2. **VSCode Test Runner**
    - Integration testing
    - Extension testing
    - Webview testing

## Development Setup

### Prerequisites

1. **Node.js and npm**

    - Required version in .nvmrc
    - npm for package management

2. **VSCode**
    - Latest stable version
    - Required extensions
    - Debug tools

### Environment Configuration

1. **Development**

    - .env files for configuration
    - VSCode launch settings
    - Debug configurations

2. **Testing**
    - Jest configuration
    - Test environment setup
    - Mock implementations

### Build Process

1. **Extension**

    - TypeScript compilation
    - Bundle generation
    - Resource copying

2. **Webview**
    - React build
    - Asset optimization
    - Theme integration

## Technical Constraints

### VSCode Extension

1. **Sandbox Limitations**

    - File system access
    - Network requests
    - Process execution

2. **Performance Requirements**
    - Startup time
    - Memory usage
    - Response time

### AI Integration

1. **Provider Requirements**

    - API key management
    - Rate limiting
    - Error handling

2. **Security Considerations**
    - Data privacy
    - Token management
    - Request validation

## Dependencies

### Production Dependencies

Key packages from package.json:

- VSCode extension SDK
- AI provider SDKs
- File system utilities
- Development tools

### Development Dependencies

- TypeScript
- Testing frameworks
- Build tools
- Linting and formatting

### External Services

1. **AI Providers**

    - Multiple provider support
    - API integration
    - Authentication

2. **Development Tools**
    - Source control (Git)
    - CI/CD integration
    - Code quality tools
