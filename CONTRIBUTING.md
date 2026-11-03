# Contributing Guidelines

Thank you for contributing to the Coursera Automation Suite. We welcome contributions that improve DOM selector resilience across Coursera interface updates, enhance accessibility, or expand productivity features.

---

## Architectural Principles

1. **DOM Selector Resilience**: Coursera frequently updates UI classes. Use stable attributes (`data-e2e`, `aria-label`, semantic tags) rather than minified CSS class names.
2. **Zero Outbound Telemetry**: Pull requests introducing external analytics, tracking scripts, or outbound webhooks will be rejected immediately.
3. **No Heavy Dependencies**: Keep userscripts pure vanilla ES6+ to ensure minimal performance impact on the browser.

---

## Code of Conduct

All contributors and participants must adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Pull Request Guidelines

1. Test changes locally across Chrome and Firefox using Tampermonkey.
2. Verify that no private data, course solutions, or credentials are committed.
3. Open a Pull Request targeting the `main` branch and complete the security checklist.
