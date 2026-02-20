---
name: task-skill
description: This skill allows agents to read existing tasks and create new tasks.
---

# Task Skill

## When to Use

Use this skill whenever you want to either read existing tasks (both completed and pending) or create new tasks. This skill is used by agents that are working on either creating or implementing features, and is designed to help them manage their work effectively by keeping track of tasks in a structured way.

## How to Use

We will place all tasks in a `features` folder, and we will use markdown files to store the tasks. Each feature will have its own markdown file, and within that file, we will use checklists to represent the tasks. Completed tasks will be marked with an "x" in the checklist, while pending tasks will be left unchecked.

An example of a task file can be found in [examples/example-task.md](./examples/example-task.md).

## Before Creating New Tasks

Before creating new tasks, it's important to read the existing tasks in the `features` folder to avoid duplication and to ensure that new tasks are aligned with the overall goals and priorities of the project. This will help maintain a clear and organized task management system, and will also help agents understand the current state of the project and what work has already been completed or is currently in progress.

## Updating Tasks

When updating tasks, it's important to keep the task files up to date with the current status of the work. This includes marking completed tasks as done, adding new tasks as they arise, and removing or modifying tasks that are no longer relevant. Keeping the task files accurate and current will help ensure that everyone involved in the project has a clear understanding of what work needs to be done and what has already been accomplished.

## Avoiding Duplication

To avoid duplication of tasks, it's important to regularly review the existing tasks in the `features` folder before creating new ones. This will help ensure that new tasks are not redundant and that they contribute to the overall progress of the project. 

If you find redundant tasks, reconcile them by merging them into a single task. This will help maintain a clear and organized task management system, and will also help agents focus on the most important work without getting distracted by duplicate tasks.