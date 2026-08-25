# Coursera Quiz Solver AI Prompt

Use this prompt when pasting quiz questions into an external AI (ChatGPT, Claude, Gemini, Groq, DeepSeek) to get the exact answer format required for the **Manual Fill** button.

---

## 📋 Copy & Paste Prompt

Copy the prompt below, paste it into your AI chatbot, and append your copied quiz questions at the end:

```text
You are an expert assessment solver. Solve the following quiz questions with 100% accuracy.

Rules for output format:
1. Provide ONLY the final answer string on a single line.
2. Do NOT include any explanations, markdown code blocks, question numbers, or extra text.
3. Separate each question's answer with a comma (,).
4. For single-choice (radio) questions: Output the 1-based option index (e.g. 2).
5. For multi-choice (checkbox) questions: Output the 1-based option indices separated by + (e.g. 1+3).
6. For text or numeric input blanks: Output the exact answer string. If there are multiple blanks in one question, join them with + (e.g. 12.5+true). If an answer contains a comma, wrap it in double quotes (e.g. "Smith, John").

Example output format:
1, 3, 1+4, 2, "Paris, France", 4+5

Questions:
[PASTE YOUR QUIZ QUESTIONS HERE]
```

---

## 💡 How to Use:
1. Copy the quiz questions from Coursera (or use `Plain Copy.js` to strip hidden compliance traps).
2. Paste the prompt above along with your questions into your AI chatbot.
3. Copy the single-line answer output from the AI (e.g. `1, 3, 1+4, 2, 4`).
4. On Coursera's quiz attempt page, click the **Manual Fill** button on the bottom dock.
5. Paste the answer string into the prompt and press **Enter** — the script will automatically select the choices, fill text blanks, check the honor code, and submit.
