# Coursera Automation Scripts Suite

A comprehensive suite of Tampermonkey scripts designed to fully automate your Coursera learning experience. Includes tools for video fast-forwarding, reading completion, universal multi-type lab launching, and **Multi-Provider AI Quiz Solving (Groq & NVIDIA NIM)** with automatic key rotation and clean circular dock UI.

**Author:** [Gohar Rehman](https://github.com/itsgoharrehman)

---

## 📂 Repository Structure

```text
coursera-api/
├── scripts/                  # Main daily-driver automation scripts
│   ├── Auto Skip Pro.js      # v2.3 Daily Driver: Shadow DOM dock, clean SVG icons, Multi-AI
│   └── Autopilot Pro.js      # v2.3 Autonomous all-in-one autopilot
├── utils/                    # Standalone tools and helpers
│   ├── Bulk Completer.js     # Direct REST API bulk completer for modules & courses
│   ├── Plain Copy.js         # Anti-AI trap clipboard sanitizer
│   └── Quiz Solver.js        # Standalone Multi-AI quiz solver (Groq + NVIDIA)
├── legacy/                   # Archived scripts kept for backup
│   └── Autopilot (Legacy).js 
├── README.md                 # Project documentation
└── quiz-prompt.md            # AI prompt & schema specifications
```

---

## 🚀 Key Features in Version 2.3

### 1. `Auto Skip Pro.js` (Recommended Daily Driver)
- **Centered Bottom Circular Dock**: Modern glassmorphic dock fixed at bottom center of your screen. Clean 36px circular buttons with sharp, logical SVG stroke icons (no emojis). Stays perfectly centered on all window resizes.
- **Shadow DOM Settings Modal**: 100% isolated inside browser Shadow DOM so host page focus-traps and hotkey interceptors cannot block typing or text editing.
- **Multi-AI Quiz Solver (Groq & NVIDIA NIM)**:
  - Supports multiple API keys with real-time rate limit auto-rotation.
  - Active models: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `meta/llama-3.3-70b-instruct`, `deepseek-ai/deepseek-r1`, `qwen/qwen3.6-27b`, etc.
  - Live model discovery via `Fetch Live Models`.
  - Automatic prompt cleaning, anti-AI trap stripping, and native React input fill.
- **Universal Multi-Type Lab Support**:
  - Automatically completes step-by-step Guided Projects side-by-side.
  - Automatically agrees and launches external LTI tools (Vocareum, Qwiklabs, Jupyter) and immediately advances.
- **Instant Skip for Green-Checked Completed Items**: Immediately advances past already completed/passed items.

---

## 🛠️ Installation & Setup

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Copy and paste the contents of [`scripts/Auto Skip Pro.js`](scripts/Auto%20Skip%20Pro.js) into Tampermonkey and save (`Ctrl+S`).
3. On Coursera, click the **Gear** icon on the bottom dock (or right-click it for quick prompt) to paste your Groq or NVIDIA API key.