def func(list1):
    str1 = "qwertyuiop"
    str2 = "asdfghjkl"
    str3 = "zxcvbnm"
    result = []
    for i in list1:
        z1 = 0
        z2 = 0
        z3 = 0
        for j in i:
            j = j.lower()
            if j in str1:
                z1 += 1
            elif j in str2:
                z2 += 1
            elif j in str3:
                z3 += 1
        if [z1, z2, z3].count(0) == 2:
            result.append(i)

    return result




