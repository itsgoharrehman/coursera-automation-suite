# coursera-automation-suite

A comprehensive Tampermonkey userscript automation suite designed to streamline navigation, playback speed, and pacing across the Coursera online learning platform.

## Architecture and Stack

* **Language**: JavaScript (Userscript context)
* **Execution Environment**: Tampermonkey / Violentmonkey browser extensions
* **DOM Integration**: MutationObserver API, custom UI control overlays

## Key Features

* **Playback Speed Normalizer**: Fine-grained playback control exceeding standard player limits (up to 3.0x speed).
* **Automated Next Lesson**: Auto-transitions across modules upon video completion.
* **Transcript Exporter**: One-click extraction of lesson transcripts for offline reference.
* **Minimal Resource Overhead**: Operates entirely in the client browser with zero network footprint.

## Getting Started

### Prerequisites
* Chromium or Firefox browser with Tampermonkey installed

### Installation
```bash
git clone https://github.com/itsgoharrehman/coursera-automation-suite.git
cd coursera-automation-suite
```
Import the `.user.js` files into your Tampermonkey dashboard.

## Maintainer

* **Gohar Rehman**
* GitHub: [@itsgoharrehman](https://github.com/itsgoharrehman)
* Email: `goharrehmanfsd260@gmail.com`
* Website: [itsgoharrehman.netlify.app](https://itsgoharrehman.netlify.app/)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
