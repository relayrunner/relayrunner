---
title: Job time split into setup, build and test
date: 2026-11-23
type: Feature
description: Performance splits the time inside each job into setup, build and test, and says which setup steps a cache covers.
---

- **Setup, build and test.** **Performance → Job types** shows the minutes inside each job type as setup, build and test. Setup is what every run does to get the machine ready: the runner, checkout, tools, packages, browsers, container images and cache steps. See [Setup, build and test](/docs/dashboard/performance#setup-build-and-test).
- **Cache you can see.** Setup counts as cached only when a cache step names what it holds or a setup action saves its cache. Anything else reads as no cache we can see, so a fast run is never taken for a cached one.
- **Per job.** A job's detail shows one strip per run, with what each phase holds on hover.
