<system-reminder>
The user manually modified the todo list ({{action}}).
{{#if cleared}}The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list.{{else if removed}}The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.{{/if}}
Current todo list:

{{checklist}}
</system-reminder>
