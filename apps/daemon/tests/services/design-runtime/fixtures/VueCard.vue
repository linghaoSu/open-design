<script lang="ts">
export const CardPolicy = {
  component: 'default',
  slots: {
    body: { codeSlot: 'default', accepts: ['text'], required: true, multiple: true },
    heading: { codeSlot: 'heading', accepts: ['text'], required: false, multiple: false },
  },
} as const;
</script>

<script setup lang="ts">
type Tone = 'quiet' | 'strong';
interface Props {
  title: string;
  tone?: Tone;
  elevated?: boolean;
  count?: number;
  empty?: null;
  busy?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  tone: 'quiet', elevated: false, count: -2, empty: null,
});
defineSlots<{ default(): unknown; heading?: () => unknown }>();
</script>

<template>
  <section :data-tone="props.tone">
    <h2>{{ props.title }}</h2>
    <slot name="heading" />
    <slot />
  </section>
</template>
