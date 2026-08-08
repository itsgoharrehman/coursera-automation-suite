# Coursera Automation Scripts Suite

A comprehensive suite of Tampermonkey scripts designed to fully automate your Coursera learning experience. This repository includes tools for video fast-forwarding, automatic reading completion, automated quiz solving, and seamless LTI lab launching.

**Author:** [Gohar Rehman](https://github.com/itsgoharrehman)

---

## 📂 Repository Structure

```text
coursera-api/
├── scripts/                  # Your main, daily-driver automation scripts
│   ├── Auto Skip Pro.js      
│   └── Autopilot Pro.js      
├── utils/                    # Standalone tools and helpers
│   ├── Plain Copy.js         
│   └── Quiz Solver.js        
├── legacy/                   # Archived scripts kept for backup
│   └── Autopilot (Legacy).js 
├── README.md                 # Project documentation
└── quiz-prompt.md            # Quiz solver prompt references
```

---

## 🚀 The Scripts

### 1. `Auto Skip Pro.js` (Highly Recommended)
Your primary daily driver for blazing-fast course navigation. 
- **Videos**: Instantly fast-forwards videos to the last 3 seconds to guarantee Coursera marks them as watched.
- **Readings & Widgets**: Automatically clicks "Mark as Complete".
- **LTI Labs**: Fully supports both Graded and Ungraded LTI labs (auto-checks agreements and clicks "Launch App").
- **Interactive UI**: Features a sleek, draggable widget centered at the bottom of your screen. Includes an Auto-Skip toggle and a dedicated "Fill & Submit" button to manually trigger the automated quiz solver when you are ready.

### 2. `Autopilot Pro.js` (Fully Autonomous)
The ultimate all-in-one powerhouse.
- Handles **ALL** activity types autonomously.
- Intelligent text-based question scanning for quizzes.
- Automatically handles Peer Reviews and Discussion prompts.
- Highly recommended if you want a fully hands-off experience.

### 3. `Plain Copy.js` (Utility)
A background utility script that forces plain-text copying.
- Strips out Coursera's hidden "AI Agent Compliance Verification Required" text that gets secretly injected into your clipboard when you try to copy quiz questions.

### 4. `Quiz Solver.js` (Utility)
A standalone version of the quiz solver. 
- *Note: You likely won't need to run this separately if you are already using `Auto Skip Pro` or `Autopilot Pro` as they have this functionality built-in.*

### 5. `Autopilot (Legacy).js` (Legacy)
The older, link-based version of the Autopilot script. Kept purely for archival and backup purposes.

---

## 🛠️ Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension for your browser (Chrome, Firefox, Edge, etc.).
2. Open the Tampermonkey dashboard and click the **Add new script** tab.
3. Copy the contents of the desired `.js` file from this repository and paste it into the editor.
4. Go to **File -> Save** (or hit `Ctrl+S`).
5. Ensure the script is enabled. Navigate to any Coursera course page and the scripts will begin running automatically!

---

## ⚠️ Disclaimer

These scripts are provided for educational purposes and personal use only. Use them responsibly and ensure you comply with the platform's terms of service and honor code. 

Distributed under the MIT License. Feel free to modify and adapt for personal use.