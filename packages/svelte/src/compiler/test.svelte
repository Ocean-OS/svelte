<script>
    let name = $state(new Promise((res) => {
        setTimeout(() => res('world'), 1000);
    }));
</script>
<h1>Hello, {name}!</h1>