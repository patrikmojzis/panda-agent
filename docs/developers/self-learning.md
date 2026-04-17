# Self-learning

- Core idea: Improve skill documents based real world feedback

Trigger a background skill-reflection pass when a run hits any of these:

update (if skill exists):
- a failed attempt followed by a successful one
- user correction changed the approach
- a reusable artifact was produced
- the run solved a non-trivial workflow, not just answered a question
- the skill contains outdated information

create (if skill does not exists)
- agent noticed repeating workflow which could be streamlined


Information pass to the subagent via prompt main agent writes (as text):
skillKey?: string
mode: "create" | "update" | "auto"
reasons: string[]
summary: string
evidence?: string
maybe loadedSkillKeys?: string[]
Where reasons is constrained to stuff like:

failed_then_succeeded
user_corrected_approach
reusable_artifact_produced
non_trivial_workflow
outdated_skill
repeating_workflow


The real core is just:

skill_load for main agent
skill-maintainer as a dedicated subagent role
main agent can invoke it with a small structured blob embedded in text
subagent decides create | update | noop
sync for now, background later

If I were pruning this down hard, I’d keep only these decisions explicit:

reflection is agent-invoked, not scheduled
maintainer reads convo from DB, not inherited transcript
skills are loaded through one path that updates metadata
maintainer is specialized, not a generic worker with random vibes
