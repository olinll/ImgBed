<template>
    <span v-bind="$attrs" class="channel-icon-wrapper">
        <font-awesome-icon :icon="fontAwesomeIcon"/>
    </span>
</template>

<script>
export default {
    name: 'ChannelIcon',
    inheritAttrs: false,
    props: {
        type: {
            type: String,
            required: true
        }
    },
    computed: {
        fontAwesomeIcon() {
            const icons = {
                s3: ['fab', 'aws'],
                local: 'server'
            };
            return icons[this.type] || 'server';
        }
    }
};
</script>

<style scoped>
.channel-icon-wrapper {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
}

.channel-svg-icon,
.channel-icon-wrapper :deep(svg) {
    width: 1em;
    height: 1em;
    fill: currentColor;
}
</style>
