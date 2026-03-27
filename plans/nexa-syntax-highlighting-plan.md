# Nexa VS Code 语法高亮插件开发计划

## 📋 项目概述

为 Nexa DSL（智能体原生编程语言）完善 VS Code 语法高亮插件。

## 🎯 目标文件

| 文件 | 用途 |
|------|------|
| `syntaxes/nexa.tmLanguage.json` | TextMate 语法定义（核心） |
| `language-configuration.json` | 语言配置（注释、括号匹配等） |
| `comprehensive_test.nexa` | 综合测试文件 |

---

## 📊 阶段一：基础结构构建

### 1.1 从解析器提取的关键字

**来源**: `/root/proj/nexa/src/nexa_parser.py`

#### 声明类关键字
```
agent, tool, flow, protocol, test, include
```

#### 控制流关键字
```
if, else, loop, until, try, catch, match, intent
```

#### 特殊语句关键字
```
semantic_if, against, fast_match, assert, print
```

#### 属性名关键字
```
role, prompt, model, memory, stream, cache, experience, 
fallback, tools, mcp, python, description, parameters,
max_tokens, timeout
```

#### 布尔字面量
```
true, false
```

#### 装饰器
```
@limit, @timeout, @retry, @temperature
```

#### 类型/接口关键字
```
uses, implements
```

### 1.2 特殊操作符

| 操作符 | 名称 | 用途 |
|--------|------|------|
| `>>` | 管道 | 顺序传递数据 |
| `|>>` | 分叉 | 并行发送到多个 Agent |
| `||` | Fire-and-Forget | 并行执行不等待 |
| `&>>` | 合流 | 顺序合并结果 |
| `&&` | 共识合流 | 共识合并结果 |
| `??` | 条件分支 | 语义条件选择 |
| `=>` | Case Arrow | 匹配分支箭头 |

### 1.3 language-configuration.json 更新

```json
{
  "comments": {
    "lineComment": "//",
    "blockComment": ["/*", "*/"]
  },
  "brackets": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"]
  ],
  "autoClosingPairs": [
    {"open": "{", "close": "}"},
    {"open": "[", "close": "]"},
    {"open": "(", "close": ")"},
    {"open": "\"", "close": "\""},
    {"open": "\"\"\"", "close": "\"\"\""}
  ],
  "surroundingPairs": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
    ["\"", "\""]
  ],
  "folding": {
    "markers": {
      "start": "^\\s*//\\s*#?region\\b",
      "end": "^\\s*//\\s*#?endregion\\b"
    }
  },
  "indentationRules": {
    "increaseIndentPattern": "^\\s*(agent|tool|flow|protocol|test|if|else|loop|try|catch|match|semantic_if)\\b.*\\{[^}]*$",
    "decreaseIndentPattern": "^\\s*\\}"
  }
}
```

---

## 📊 阶段二：分主题迭代计划

### 周期 A：Agent 声明与属性语法

**语法模式**:
```nexa
agent BotName {
    role: "角色描述",
    prompt: "任务指令",
    model: "provider/model-name",
    memory: "persistent",
    stream: true,
    cache: false,
    experience: "memory.md",
    tools: [Tool1, Tool2],
    fallback: ["backup-model"],
    max_tokens: 4096,
    timeout: 60
}
```

**TextMate 规则**:
- `keyword.declaration.agent.nexa` - `agent` 关键字
- `entity.name.type.agent.nexa` - Agent 名称
- `variable.parameter.attribute.nexa` - 属性名
- `string.quoted.double.nexa` - 字符串值
- `constant.language.boolean.nexa` - true/false

### 周期 B：Tool 声明语法

**语法模式**:
```nexa
tool ToolName {
    description: "工具描述",
    parameters: {
        "param1": "类型",
        "param2": "类型"
    }
}

tool MCPTool {
    mcp: "github.com/repo/mcp-server"
}

tool PythonTool {
    python: "def execute(): ..."
}
```

**TextMate 规则**:
- `keyword.declaration.tool.nexa` - `tool` 关键字
- `entity.name.type.tool.nexa` - Tool 名称
- `variable.parameter.attribute.nexa` - description/parameters/mcp/python

### 周期 C：Flow 流程与语句语法

**语法模式**:
```nexa
flow flowName(param1: Type, param2: Type) {
    // 赋值语句
    result = Agent.run("input");
    
    // 打印语句
    print(result);
    
    // 断言语句
    assert result != null;
    
    // if 语句
    if (condition) {
        // ...
    } else {
        // ...
    }
    
    // loop 语句
    loop {
        // ...
    } until (condition);
    
    // try-catch 语句
    try {
        // ...
    } catch (error) {
        // ...
    }
}
```

**TextMate 规则**:
- `keyword.declaration.flow.nexa` - `flow` 关键字
- `entity.name.function.flow.nexa` - Flow 名称
- `variable.parameter.nexa` - 参数名
- `keyword.control.nexa` - if/else/loop/until/try/catch
- `keyword.other.statement.nexa` - assert/print

### 周期 D：DAG 操作符

**语法模式**:
```nexa
// 管道
result = input >> Agent1 >> Agent2;

// 分叉
results = input |>> [Agent1, Agent2, Agent3];

// Fire-and-Forget
input || [Agent1, Agent2];

// 合流
result = [Agent1, Agent2] &>> MergerAgent;

// 共识合流
result = [Agent1, Agent2] && ConsensusAgent;

// 条件分支
result = input ?? TrueAgent : FalseAgent;
```

**TextMate 规则**:
- `keyword.operator.pipeline.nexa` - `>>`
- `keyword.operator.fork.nexa` - `|>>`
- `keyword.operator.fire-forget.nexa` - `||`
- `keyword.operator.merge.nexa` - `&>>`
- `keyword.operator.consensus.nexa` - `&&`
- `keyword.operator.conditional.nexa` - `??`

### 周期 E：Protocol 协议声明

**语法模式**:
```nexa
protocol ResponseFormat {
    status: "success | error",
    data: "响应数据",
    message: "可选消息"
}
```

**TextMate 规则**:
- `keyword.declaration.protocol.nexa` - `protocol` 关键字
- `entity.name.type.protocol.nexa` - Protocol 名称

### 周期 F：Test 与 Assert 语法

**语法模式**:
```nexa
test "测试名称" {
    result = Agent.run("test input");
    assert "期望结果描述" against result;
}
```

**TextMate 规则**:
- `keyword.declaration.test.nexa` - `test` 关键字
- `string.quoted.double.test-name.nexa` - 测试名称
- `keyword.other.assert.nexa` - `assert` 关键字
- `keyword.other.against.nexa` - `against` 关键字

### 周期 G：语义条件 semantic_if

**语法模式**:
```nexa
// 原有语法
semantic_if "是一句日期提示" fast_match r"\d{4}-\d{2}" against input {
    // 处理逻辑
} else {
    // 其他处理
}

// 简化语法
semantic_if (input, "判断条件") {
    "case1" => action1,
    "case2" => action2
}
```

**TextMate 规则**:
- `keyword.control.semantic-if.nexa` - `semantic_if` 关键字
- `keyword.other.fast-match.nexa` - `fast_match` 关键字
- `keyword.other.against.nexa` - `against` 关键字
- `string.regexp.nexa` - 正则表达式

### 周期 H：Match 模式匹配

**语法模式**:
```nexa
match input {
    intent("查询天气") => handleWeather(),
    intent("设置提醒") => handleReminder(),
    _ => handleDefault()
}
```

**TextMate 规则**:
- `keyword.control.match.nexa` - `match` 关键字
- `keyword.other.intent.nexa` - `intent` 关键字
- `keyword.operator.arrow.nexa` - `=>` 操作符
- `variable.language.default.nexa` - `_` 默认匹配

### 周期 I：装饰器语法

**语法模式**:
```nexa
@limit(max_tokens=1000)
@timeout(seconds=30)
@retry(max_attempts=3)
@temperature(value=0.7)
agent SmartBot {
    prompt: "..."
}
```

**TextMate 规则**:
- `meta.decorator.nexa` - 装饰器整体
- `entity.name.function.decorator.nexa` - 装饰器名称
- `variable.parameter.decorator.nexa` - 装饰器参数

### 周期 J：内置函数与标准库调用

**语法模式**:
```nexa
// Agent 方法调用
result = Agent.run("input");
result = Agent.run_async("input");

// 标准库调用
std.log("message");
std.http.get("url");
```

**TextMate 规则**:
- `support.function.agent-method.nexa` - run, run_async
- `support.function.stdlib.nexa` - std.* 方法

---

## 📊 阶段三：兜底排查

### 3.1 全局搜索遗漏

- [ ] 搜索源码中所有 `"` 包围的字符串字面量
- [ ] 搜索所有正则表达式模式
- [ ] 检查是否有未覆盖的操作符

### 3.2 作用域嵌套检查

- [ ] 确保字符串内的转义字符正确处理
- [ ] 确保嵌套大括号正确匹配
- [ ] 确保多行字符串正确高亮

### 3.3 测试文件验证

创建 `comprehensive_test.nexa` 包含所有语法特性的复杂混合场景。

---

## 📁 文件修改清单

### syntaxes/nexa.tmLanguage.json 完整结构

```json
{
  "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  "name": "Nexa",
  "scopeName": "source.nexa",
  "patterns": [
    { "include": "#comments" },
    { "include": "#decorators" },
    { "include": "#declarations" },
    { "include": "#control-flow" },
    { "include": "#dag-operators" },
    { "include": "#strings" },
    { "include": "#numbers" },
    { "include": "#booleans" },
    { "include": "#keywords" },
    { "include": "#identifiers" }
  ],
  "repository": {
    "comments": { ... },
    "decorators": { ... },
    "declarations": { ... },
    "control-flow": { ... },
    "dag-operators": { ... },
    "strings": { ... },
    "numbers": { ... },
    "booleans": { ... },
    "keywords": { ... },
    "identifiers": { ... }
  }
}
```

---

## 🚀 执行顺序

1. **立即执行**: 更新 `language-configuration.json`
2. **立即执行**: 创建基础 `nexa.tmLanguage.json` 框架
3. **立即执行**: 创建 `comprehensive_test.nexa` 基础版本
4. **迭代执行**: 按周期 A-J 逐步完善语法规则
5. **最终执行**: 兜底排查与验证

---

## 📝 注意事项

1. **使用标准 TextMate Scope 命名**：确保兼容主流颜色主题
2. **正则表达式性能**：避免回溯过深的模式
3. **作用域嵌套**：确保子模式正确继承父作用域
4. **测试覆盖**：每个周期完成后立即更新测试文件