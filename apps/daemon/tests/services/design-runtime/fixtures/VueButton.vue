<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'secondary'; label?: string }>(), { variant: 'primary', label: 'Continue' });
</script>
<template><button>{{ label }}</button></template>
