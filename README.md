# Nexa Language Extension for VS Code

A comprehensive Visual Studio Code extension providing syntax highlighting and language support for **Nexa** - a Domain Specific Language (DSL) for building AI Agent orchestration systems.

## ✨ Features

- 🎨 **Full Syntax Highlighting** - Complete coverage of Nexa DSL syntax
- 📝 **Comment Support** - Single-line (`//`) and multi-line (`/* */`) comments
- 🔗 **Bracket Matching** - Auto-closing and matching for `{}`, `[]`, `()`
- 📁 **Code Folding** - Support for folding code blocks
- 🎯 **Standard TextMate Scopes** - Compatible with popular color themes

## 📦 Installation

### From VSIX (Manual Install)

1. Download the `.vsix` file from releases
2. Open VS Code
3. Go to Extensions (Ctrl+Shift+X)
4. Click the "..." menu → "Install from VSIX..."
5. Select the downloaded file

### From Source

```bash
git clone https://github.com/ouyangyipeng/Nexa-extension.git
cd Nexa-extension
npm install
npm run compile
# Press F5 in VS Code to launch extension development host
```

## 🚀 Supported Syntax

### Declarations

```nexa
// Agent declaration with return type
agent MyAgent -> str {
    role: "Assistant",
    prompt: "You are a helpful assistant.",
    model: "gpt-4"
}

// Tool declaration
tool SearchTool {
    description: "Search the web",
    parameters: {
        "query": "string"
    }
}

// Flow declaration with parameters
flow main(input: string) {
    result = MyAgent.run(input);
}

// Protocol declaration
protocol Response {
    status: "string",
    data: "dict"
}
```

### DAG Operators

```nexa
// Pipeline
result = input >> Agent1 >> Agent2;

// Fan-out (parallel)
results = input |>> [Agent1, Agent2, Agent3];

// Merge
result = [Agent1, Agent2] &>> MergerAgent;

// Conditional branch
result = input ?? TrueAgent : FalseAgent;

// Consensus merge
result = [Agent1, Agent2] && JudgeAgent;
```

### Control Flow

```nexa
// If-else
if (condition) {
    print("true");
} else {
    print("false");
}

// Loop with semantic condition
loop {
    draft = Writer.run(task);
    feedback = Reviewer.run(draft);
} until ("The output is satisfactory");

// Try-catch
try {
    result = RiskyAgent.run("task");
} catch (error) {
    print(error);
}

// Match intent
match input {
    intent("greeting") => GreetBot.run(input),
    intent("question") => QABot.run(input),
    _ => DefaultBot.run(input)
}
```

### Semantic Conditions

```nexa
// Semantic if with fast_match
semantic_if "contains date" fast_match r"\d{4}-\d{2}-\d{2}" against input {
    print("Date detected");
} else {
    print("No date");
}

// Simplified semantic_if
semantic_if (input, "check condition") {
    "case1" => Action1,
    "case2" => Action2
}
```

### Standard Library

```nexa
// File system
agent FileBot uses std.fs {
    prompt: "Manage files"
}

// HTTP requests
agent WebBot uses std.http {
    prompt: "Fetch web content"
}

// Shell commands
agent ShellBot uses std.shell {
    prompt: "Execute commands"
}

// Multiple std modules
agent SuperBot uses std.fs, std.http, std.time {
    prompt: "Multi-capability bot"
}
```

### Decorators

```nexa
@limit(max_tokens=1000)
@timeout(30)
@retry(3)
agent RateLimitedAgent {
    prompt: "I have rate limits"
}
```

### Built-in Functions

```nexa
// Join multiple agents
result = join(Agent1, Agent2).Merger("combine");

// Image processing
img_data = img("path/to/image.png");

// Secret management
api_key = secret("API_KEY");
```

## 📁 Project Structure

```
nexa-lang/
├── .vscode/
│   └── launch.json          # Extension debug config
├── syntaxes/
│   └── nexa.tmLanguage.json # TextMate grammar definition
├── language-configuration.json
├── package.json
├── comprehensive_test.nexa  # Test file with all syntax
└── README.md
```

## 🎨 Scope Reference

| Scope | Description |
|-------|-------------|
| `keyword.declaration.agent.nexa` | `agent` keyword |
| `keyword.declaration.flow.nexa` | `flow` keyword |
| `keyword.control.nexa` | Control flow keywords |
| `keyword.operator.dag.nexa` | DAG operators (`>>`, `|>>`, etc.) |
| `entity.name.type.agent.nexa` | Agent names |
| `entity.name.function.nexa` | Function names |
| `variable.parameter.attribute.nexa` | Agent attributes |
| `support.function.builtin.nexa` | Built-in functions |
| `support.class.stdlib.nexa` | Standard library |
| `string.quoted.double.nexa` | Double-quoted strings |
| `comment.line.double-slash.nexa` | Line comments |

## 🔧 Development

### Prerequisites

- Node.js 16+
- VS Code

### Build

```bash
npm install
npm run compile
```

### Package

```bash
npx vsce package
```

## 📄 License

MIT License

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📚 Resources

- [Nexa Language Documentation](https://github.com/nexa-lang/nexa)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [TextMate Grammar](https://macromates.com/manual/en/language_grammars)

---

Made with ❤️ for the Nexa community