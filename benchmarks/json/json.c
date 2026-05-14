// JSON parse + walk via yyjson
#include <stdio.h>
#include <stdlib.h>
#include <yyjson.h>

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: json <file>\n"); return 2; }
    yyjson_doc* doc = yyjson_read_file(argv[1], 0, NULL, NULL);
    if (!doc) { fprintf(stderr, "parse failed\n"); return 1; }
    yyjson_val* root = yyjson_doc_get_root(doc);
    yyjson_val* items = yyjson_obj_get(root, "items");
    double sum_price = 0;
    long active_count = 0;
    size_t idx, max;
    yyjson_val* item;
    yyjson_arr_foreach(items, idx, max, item) {
        sum_price += yyjson_get_real(yyjson_obj_get(item, "price"));
        if (yyjson_get_bool(yyjson_obj_get(item, "active"))) active_count++;
    }
    printf("items=%zu sum=%.2f active=%ld\n", max, sum_price, active_count);
    yyjson_doc_free(doc);
    return 0;
}
